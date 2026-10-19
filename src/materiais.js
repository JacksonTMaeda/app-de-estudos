// Materiais em PDF: o app guarda só o caminho e a página onde parou. O PDF nunca é copiado,
// movido nem alterado; ele continua na pasta de quem estuda.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { transacao } from './db.js';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS material (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  materia_id INTEGER REFERENCES materia(id) ON DELETE SET NULL,
  caminho TEXT NOT NULL,
  nome TEXT NOT NULL,
  pasta TEXT NOT NULL DEFAULT '',
  paginas INTEGER,
  ultima_pagina INTEGER NOT NULL DEFAULT 1,
  aberto_em TEXT,
  UNIQUE (plano_id, caminho)
);
`;
const PROFUNDIDADE = 4;
const LIMITE = 5000;

export function prepararMateriais(db) {
  try {
    db.exec(ESQUEMA);
  } catch (erro) {
    // Aberto só para leitura (servidor MCP): o app cria a tabela na próxima vez que abrir.
    if (!/readonly/i.test(erro.message)) throw erro;
  }
}

const chave = (planoId) => `pasta_materiais:${planoId}`;

export function pastaDoPlano(db, planoId) {
  const linha = db.prepare('SELECT valor FROM preferencia WHERE chave = ?').get(chave(planoId));
  return linha ? JSON.parse(linha.valor) : null;
}

// Palavras de um nome, sem acento, sem caixa e sem as ligações (de, do, e...).
const LIGACOES = new Set(['a', 'o', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no']);
function palavras(nome) {
  return nome
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().split(/[^a-z0-9]+/)
    .filter((p) => p && !LIGACOES.has(p));
}
// "portugues" casa com "portuguesa"; palavras curtas só casam iguais.
const casa = (a, b) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));

// Acha a matéria cujo nome mais se parece com o da pasta. Precisa cobrir 3/4 das palavras do nome
// mais curto; no empate, ganha o nome com menos palavras sobrando ("Direito Penal Aplicado" não vira
// "Direito Processual Penal Aplicado").
export function materiaDaPasta(nomePasta, materias) {
  const p = palavras(nomePasta);
  if (p.length === 0) return null;
  let melhor = null;
  for (const m of materias) {
    const q = palavras(m.nome);
    if (q.length === 0) continue;
    const comuns = p.filter((x) => q.some((y) => casa(x, y))).length;
    const cobertura = comuns / Math.min(p.length, q.length);
    const parecido = comuns / (p.length + q.length - comuns);
    if (cobertura < 0.75) continue;
    if (!melhor || cobertura > melhor.cobertura || (cobertura === melhor.cobertura && parecido > melhor.parecido)) {
      melhor = { id: m.id, cobertura, parecido };
    }
  }
  return melhor?.id ?? null;
}

function acharPdfs(raiz) {
  const achados = [];
  const andar = (pasta, nivel) => {
    if (nivel > PROFUNDIDADE || achados.length >= LIMITE) return;
    let itens;
    try {
      itens = readdirSync(pasta, { withFileTypes: true });
    } catch {
      return; // pasta sem permissão: segue com as outras
    }
    for (const item of itens) {
      const caminho = join(pasta, item.name);
      if (item.isDirectory()) andar(caminho, nivel + 1);
      else if (item.isFile() && /\.pdf$/i.test(item.name)) achados.push(caminho);
    }
  };
  andar(raiz, 0);
  return achados;
}

// Lê a pasta e atualiza a lista: PDF novo entra (com a matéria pelo nome da primeira subpasta),
// o que já estava fica como está (página e matéria escolhida à mão), o que sumiu da pasta sai da lista.
export function escanearPasta(db, planoId, raiz) {
  raiz = resolve(raiz);
  if (!existsSync(raiz) || !statSync(raiz).isDirectory()) throw new Error(`Pasta não encontrada: ${raiz}`);
  const materias = db.prepare('SELECT id, nome FROM materia WHERE plano_id = ?').all(planoId);
  const pdfs = acharPdfs(raiz);
  return transacao(db, () => {
    db.prepare(`INSERT INTO preferencia (chave, valor) VALUES (?, ?)
      ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor`).run(chave(planoId), JSON.stringify(raiz));
    const existentes = new Set(db.prepare('SELECT caminho FROM material WHERE plano_id = ?').all(planoId).map((m) => m.caminho));
    const inserir = db.prepare('INSERT INTO material (plano_id, materia_id, caminho, nome, pasta) VALUES (?, ?, ?, ?, ?)');
    let novos = 0;
    const cacheMateria = new Map();
    for (const caminho of pdfs) {
      if (existentes.delete(caminho)) continue;
      const partes = relative(raiz, caminho).split(sep);
      const pasta = partes.slice(0, -1).join(' / ');
      const primeira = partes.length > 1 ? partes[0] : '';
      if (!cacheMateria.has(primeira)) cacheMateria.set(primeira, primeira ? materiaDaPasta(primeira, materias) : null);
      inserir.run(planoId, cacheMateria.get(primeira), caminho, partes.at(-1).replace(/\.pdf$/i, ''), pasta);
      novos++;
    }
    const apagar = db.prepare('DELETE FROM material WHERE plano_id = ? AND caminho = ?');
    for (const sumiu of existentes) apagar.run(planoId, sumiu);
    return { pasta: raiz, total: pdfs.length, novos, sumiram: existentes.size };
  });
}

export function listarMateriais(db, planoId) {
  return db.prepare(`
    SELECT mt.id, mt.nome, mt.pasta, mt.materia_id, m.nome AS materia, m.cor,
           mt.paginas, mt.ultima_pagina, mt.aberto_em
    FROM material mt LEFT JOIN materia m ON m.id = mt.materia_id
    WHERE mt.plano_id = ?
    ORDER BY m.posicao IS NULL, m.posicao, mt.pasta, mt.nome`).all(planoId);
}

export function obterMaterial(db, materialId) {
  const m = db.prepare(`SELECT mt.*, m.nome AS materia FROM material mt LEFT JOIN materia m ON m.id = mt.materia_id
    WHERE mt.id = ?`).get(materialId);
  if (!m) throw new Error(`Material ${materialId} não existe.`);
  return m;
}

export function associarMateria(db, materialId, materiaId) {
  const mt = obterMaterial(db, materialId);
  if (materiaId != null && !db.prepare('SELECT 1 FROM materia WHERE id = ? AND plano_id = ?').get(materiaId, mt.plano_id)) {
    throw new Error('Essa matéria não é do plano deste material.');
  }
  db.prepare('UPDATE material SET materia_id = ? WHERE id = ?').run(materiaId ?? null, materialId);
}

export function guardarPagina(db, materialId, pagina, paginas) {
  const p = Math.max(1, Math.floor(Number(pagina) || 1));
  const total = paginas ? Math.floor(Number(paginas)) : null;
  db.prepare(`UPDATE material SET ultima_pagina = ?, paginas = COALESCE(?, paginas), aberto_em = datetime('now', 'localtime')
    WHERE id = ?`).run(total ? Math.min(p, total) : p, total, materialId);
}

// Bytes do PDF para o leitor. Só lê o que está na lista E dentro da pasta escolhida para o plano:
// um caminho adulterado no banco não vira leitura de arquivo qualquer do PC.
export function lerPdf(db, materialId) {
  const mt = obterMaterial(db, materialId);
  const raiz = pastaDoPlano(db, mt.plano_id);
  const rel = raiz ? relative(raiz, mt.caminho) : '';
  if (!raiz || !rel || rel.startsWith('..') || isAbsolute(rel) || !/\.pdf$/i.test(mt.caminho)) {
    throw new Error('Material fora da pasta de materiais do plano.');
  }
  if (!existsSync(mt.caminho)) throw new Error(`O arquivo não está mais na pasta: ${mt.nome}. Atualize a lista.`);
  return readFileSync(mt.caminho);
}
