// Materiais em PDF: o app guarda só o caminho e a página onde parou. O PDF nunca é copiado,
// movido nem alterado; ele continua na pasta de quem estuda. Grifos e notas também moram no banco.
import { readdirSync, readFileSync, existsSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { colunasDe, transacao } from './db.js';

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

-- 1.2: grifos, sublinhados e notas do leitor. Presos à impressão digital do PDF (sha256 dos bytes),
-- não ao material: mover ou renomear o arquivo, ou usá-lo em outro plano, não perde as marcações.
-- Retângulos em fração da página (0 a 1), para valer em qualquer zoom.
CREATE TABLE IF NOT EXISTS marcacao (
  id INTEGER PRIMARY KEY,
  arquivo TEXT NOT NULL,
  pagina INTEGER NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('grifo', 'sublinhado', 'nota')),
  cor TEXT NOT NULL,
  retangulos TEXT NOT NULL,
  texto TEXT NOT NULL DEFAULT '',
  nota TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS marcacao_arquivo ON marcacao (arquivo, pagina);

-- 1.6: áudios (podcasts) achados na mesma pasta dos PDFs. Como o PDF, o arquivo nunca é copiado:
-- o app guarda o caminho, onde parou (segundos) e quando foi ouvido até o fim.
CREATE TABLE IF NOT EXISTS audio (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  materia_id INTEGER REFERENCES materia(id) ON DELETE SET NULL,
  caminho TEXT NOT NULL,
  nome TEXT NOT NULL,
  pasta TEXT NOT NULL DEFAULT '',
  duracao REAL,
  posicao REAL NOT NULL DEFAULT 0,
  tocado_em TEXT,
  ouvido_em TEXT,
  UNIQUE (plano_id, caminho)
);
`;
export const AUDIO = /\.(m4a|mp3|wav|ogg|oga|opus|aac|flac)$/i;
const PROFUNDIDADE = 4;
const LIMITE = 5000;

export function prepararMateriais(db) {
  try {
    db.exec(ESQUEMA);
    if (!colunasDe(db, 'material').has('arquivo')) db.exec('ALTER TABLE material ADD COLUMN arquivo TEXT');
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

// Devolve os PDFs e os áudios achados e as pastas que não deu para ler (sem permissão, em uso...).
export function acharPdfs(raiz) {
  const achados = [];
  const audios = [];
  const ilegiveis = [];
  const andar = (pasta, nivel) => {
    if (nivel > PROFUNDIDADE || achados.length + audios.length >= LIMITE) return;
    let itens;
    try {
      itens = readdirSync(pasta, { withFileTypes: true });
    } catch {
      ilegiveis.push(pasta); // segue com as outras; o que estava listado dela fica na lista
      return;
    }
    for (const item of itens) {
      const caminho = join(pasta, item.name);
      if (item.isDirectory()) andar(caminho, nivel + 1);
      else if (item.isFile() && /\.pdf$/i.test(item.name)) achados.push(caminho);
      else if (item.isFile() && AUDIO.test(item.name)) audios.push(caminho);
    }
  };
  andar(raiz, 0);
  return { pdfs: achados, audios, ilegiveis };
}

const dentroDe = (raiz, caminho) => {
  const rel = relative(raiz, caminho);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// Lê a pasta e atualiza a lista: PDF novo entra (com a matéria pelo nome da primeira subpasta),
// o que já estava fica como está (página e matéria escolhida à mão), o que sumiu da pasta sai da lista.
// PDF de subpasta que não deu para ler fica na lista: não sumiu, só não foi possível conferir.
export function escanearPasta(db, planoId, raiz, achar = acharPdfs) {
  raiz = resolve(raiz);
  if (!existsSync(raiz) || !statSync(raiz).isDirectory()) throw new Error(`Pasta não encontrada: ${raiz}`);
  const materias = db.prepare('SELECT id, nome FROM materia WHERE plano_id = ?').all(planoId);
  const { pdfs, audios = [], ilegiveis } = achar(raiz);
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
    let sumiram = 0;
    for (const caminho of existentes) {
      if (ilegiveis.some((pasta) => dentroDe(pasta, caminho))) continue;
      apagar.run(planoId, caminho);
      sumiram++;
    }
    const sons = sincronizarAudios(db, planoId, raiz, audios, ilegiveis, materias);
    return { pasta: raiz, total: pdfs.length, novos, sumiram, audios: sons, pastas_ilegiveis: ilegiveis };
  });
}

// Áudio novo entra ligado à matéria pelo nome da primeira subpasta; se o nome não casa (ex.: "CTB"),
// herda a matéria que a maioria dos PDFs dessa subpasta tem (inclusive a escolhida à mão).
function sincronizarAudios(db, planoId, raiz, audios, ilegiveis, materias) {
  const existentes = new Set(db.prepare('SELECT caminho FROM audio WHERE plano_id = ?').all(planoId).map((a) => a.caminho));
  const inserir = db.prepare('INSERT INTO audio (plano_id, materia_id, caminho, nome, pasta) VALUES (?, ?, ?, ?, ?)');
  const daMaioria = db.prepare(`SELECT materia_id FROM material WHERE plano_id = ? AND materia_id IS NOT NULL
    AND (pasta = ? OR pasta LIKE ? ESCAPE '\\') GROUP BY materia_id ORDER BY count(*) DESC LIMIT 1`);
  const escapar = (t) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
  const cache = new Map();
  const materiaDe = (primeira) => {
    if (!primeira) return null;
    if (!cache.has(primeira)) {
      cache.set(primeira, materiaDaPasta(primeira, materias) ?? daMaioria.get(planoId, primeira, `${escapar(primeira)} / %`)?.materia_id ?? null);
    }
    return cache.get(primeira);
  };
  const semDuracao = new Set(db.prepare('SELECT caminho FROM audio WHERE plano_id = ? AND duracao IS NULL').all(planoId).map((a) => a.caminho));
  const gravarDuracao = db.prepare('UPDATE audio SET duracao = ? WHERE plano_id = ? AND caminho = ? AND duracao IS NULL');
  let novos = 0;
  for (const caminho of audios) {
    if (!existentes.delete(caminho)) {
      const partes = relative(raiz, caminho).split(sep);
      inserir.run(planoId, materiaDe(partes.length > 1 ? partes[0] : ''), caminho, partes.at(-1).replace(AUDIO, ''), partes.slice(0, -1).join(' / '));
      novos++;
    } else if (!semDuracao.has(caminho)) continue;
    // Duração lida do cabeçalho do M4A, para a lista já mostrar quanto dura antes de tocar.
    const duracao = duracaoMp4(caminho);
    if (duracao) gravarDuracao.run(duracao, planoId, caminho);
  }
  const apagar = db.prepare('DELETE FROM audio WHERE plano_id = ? AND caminho = ?');
  let sumiram = 0;
  for (const caminho of existentes) {
    if (ilegiveis.some((pasta) => dentroDe(pasta, caminho))) continue;
    apagar.run(planoId, caminho);
    sumiram++;
  }
  return { total: audios.length, novos, sumiram };
}

// Duração em segundos de um M4A/MP4, pelo átomo mvhd dentro do moov. Lê só os cabeçalhos das caixas,
// não o arquivo inteiro (o podcast tem 30 a 50 MB). Qualquer coisa estranha devolve null.
export function duracaoMp4(caminho) {
  if (!/\.(m4a|mp4)$/i.test(caminho)) return null;
  let fd;
  try {
    fd = openSync(caminho, 'r');
    const tamanho = fstatSync(fd).size;
    const ler = (pos, n) => {
      const b = Buffer.alloc(n);
      return readSync(fd, b, 0, n, pos) === n ? b : null;
    };
    for (let pos = 0; pos + 8 <= tamanho; ) {
      const cab = ler(pos, 16);
      if (!cab) return null;
      let tam = cab.readUInt32BE(0);
      const tipo = cab.toString('latin1', 4, 8);
      let corpo = 8;
      if (tam === 1) {
        tam = Number(cab.readBigUInt64BE(8));
        corpo = 16;
      } else if (tam === 0) tam = tamanho - pos;
      if (tam < corpo) return null;
      if (tipo === 'moov') {
        const moov = ler(pos + corpo, Math.min(tam - corpo, 32 * 1024 * 1024));
        if (!moov) return null;
        for (let p = 0; p + 8 <= moov.length; ) {
          const t = moov.readUInt32BE(p);
          if (t < 8) return null;
          if (moov.toString('latin1', p + 4, p + 8) === 'mvhd') {
            const v = moov[p + 8];
            const escala = v === 1 ? moov.readUInt32BE(p + 28) : moov.readUInt32BE(p + 20);
            const dur = v === 1 ? Number(moov.readBigUInt64BE(p + 32)) : moov.readUInt32BE(p + 24);
            return escala > 0 && dur > 0 ? Math.round((dur / escala) * 10) / 10 : null;
          }
          p += t;
        }
        return null;
      }
      pos += tam;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---------- áudios (podcasts) ----------
const temTabelaAudio = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'audio'").get();

export function listarAudios(db, planoId) {
  if (!temTabelaAudio(db)) return [];
  return db.prepare(`
    SELECT a.id, a.nome, a.pasta, a.materia_id, m.nome AS materia, m.cor,
           a.duracao, a.posicao, a.tocado_em, a.ouvido_em
    FROM audio a LEFT JOIN materia m ON m.id = a.materia_id
    WHERE a.plano_id = ?
    ORDER BY m.posicao IS NULL, m.posicao, a.pasta, a.nome`).all(planoId);
}

export function obterAudio(db, audioId) {
  const a = temTabelaAudio(db) && db.prepare(`SELECT a.*, m.nome AS materia FROM audio a LEFT JOIN materia m ON m.id = a.materia_id
    WHERE a.id = ?`).get(audioId);
  if (!a) throw new Error(`Áudio ${audioId} não existe.`);
  return a;
}

export function associarMateriaAudio(db, audioId, materiaId) {
  const a = obterAudio(db, audioId);
  if (materiaId != null && !db.prepare('SELECT 1 FROM materia WHERE id = ? AND plano_id = ?').get(materiaId, a.plano_id)) {
    throw new Error('Essa matéria não é do plano deste áudio.');
  }
  db.prepare('UPDATE audio SET materia_id = ? WHERE id = ?').run(materiaId ?? null, audioId);
}

// Onde parou, em segundos. A duração vem do player na primeira vez que o áudio toca.
export function guardarPosicao(db, audioId, posicao, duracao) {
  obterAudio(db, audioId);
  const p = Math.max(0, Number(posicao) || 0);
  const d = Number(duracao) > 0 ? Number(duracao) : null;
  db.prepare(`UPDATE audio SET posicao = ?, duracao = COALESCE(?, duracao), tocado_em = datetime('now', 'localtime')
    WHERE id = ?`).run(Math.round((d ? Math.min(p, d) : p) * 10) / 10, d, audioId);
}

// Ouvido até o fim (ou marcado à mão). Desmarcar volta para "não ouvido" sem perder onde parou.
export function marcarOuvido(db, audioId, ouvido = true) {
  obterAudio(db, audioId);
  db.prepare(`UPDATE audio SET ouvido_em = ${ouvido ? "datetime('now', 'localtime')" : 'NULL'} WHERE id = ?`).run(audioId);
  return obterAudio(db, audioId);
}

// Bytes do áudio para o player, com a mesma trava do PDF: só o que está na lista e dentro da pasta do plano.
export function lerAudio(db, audioId) {
  const a = obterAudio(db, audioId);
  const raiz = pastaDoPlano(db, a.plano_id);
  if (!raiz || !dentroDe(raiz, a.caminho) || !AUDIO.test(a.caminho)) throw new Error('Áudio fora da pasta de materiais do plano.');
  if (!existsSync(a.caminho)) throw new Error(`O arquivo não está mais na pasta: ${a.nome}. Atualize a lista.`);
  return readFileSync(a.caminho);
}

export const TIPO_AUDIO = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac' };

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
  if (!raiz || !dentroDe(raiz, mt.caminho) || !/\.pdf$/i.test(mt.caminho)) {
    throw new Error('Material fora da pasta de materiais do plano.');
  }
  if (!existsSync(mt.caminho)) throw new Error(`O arquivo não está mais na pasta: ${mt.nome}. Atualize a lista.`);
  const bytes = readFileSync(mt.caminho);
  const arquivo = createHash('sha256').update(bytes).digest('hex');
  if (arquivo !== mt.arquivo) db.prepare('UPDATE material SET arquivo = ? WHERE id = ?').run(arquivo, materialId);
  return bytes;
}

// ---------- marcações do leitor ----------
export const TIPOS_MARCACAO = ['grifo', 'sublinhado', 'nota'];
export const CORES_MARCACAO = ['amarelo', 'verde', 'azul', 'rosa'];
const MAX_RETANGULOS = 400;
const MAX_TEXTO = 5000;

const temArquivo = (db) => colunasDe(db, 'material').has('arquivo');

// Impressão digital do PDF; só existe depois que o leitor abriu o arquivo uma vez.
function arquivoDe(db, materialId) {
  const { arquivo } = obterMaterial(db, materialId);
  if (!arquivo) throw new Error('Abra o PDF no leitor antes de marcar.');
  return arquivo;
}

const lerMarcacao = (m) => ({ ...m, retangulos: JSON.parse(m.retangulos) });
// Na página, de cima para baixo: é a ordem de leitura.
const ordemDeLeitura = (a, b) => a.pagina - b.pagina || (a.retangulos[0]?.[1] ?? 0) - (b.retangulos[0]?.[1] ?? 0) || a.id - b.id;

function obterMarcacao(db, id) {
  const m = db.prepare('SELECT id, pagina, tipo, cor, retangulos, texto, nota, criado_em FROM marcacao WHERE id = ?').get(id);
  if (!m) throw new Error(`Marcação ${id} não existe.`);
  return lerMarcacao(m);
}

const textoLimpo = (t, campo) => {
  if (t == null) return null;
  if (typeof t !== 'string') throw new Error(`${campo} precisa ser texto.`);
  const limpo = t.replace(/\s+/g, ' ').trim();
  if (limpo.length > MAX_TEXTO) throw new Error(`${campo} passa de ${MAX_TEXTO} caracteres.`);
  return limpo;
};
// Nota guarda as quebras de linha; o trecho grifado não.
const notaLimpa = (t) => {
  if (t == null) return null;
  if (typeof t !== 'string') throw new Error('A nota precisa ser texto.');
  const limpa = t.replace(/\r\n/g, '\n').trim();
  if (limpa.length > MAX_TEXTO) throw new Error(`A nota passa de ${MAX_TEXTO} caracteres.`);
  return limpa || null;
};

function validarCor(cor) {
  if (!CORES_MARCACAO.includes(cor)) throw new Error(`Cor desconhecida: ${cor}. Use ${CORES_MARCACAO.join(', ')}.`);
  return cor;
}

// Cada retângulo é [x, y, largura, altura] em fração da página.
function validarRetangulos(rets) {
  const fracao = (x) => typeof x === 'number' && Number.isFinite(x) && x >= -0.01 && x <= 1.01;
  if (!Array.isArray(rets) || rets.length === 0 || rets.length > MAX_RETANGULOS) throw new Error('Marcação sem retângulos válidos.');
  for (const r of rets) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(fracao)) throw new Error('Retângulo fora da página.');
  }
  return rets.map((r) => r.map((x) => Math.round(x * 10000) / 10000));
}

export function listarMarcacoes(db, materialId) {
  const { arquivo } = obterMaterial(db, materialId);
  if (!arquivo) return [];
  return db.prepare('SELECT id, pagina, tipo, cor, retangulos, texto, nota, criado_em FROM marcacao WHERE arquivo = ?')
    .all(arquivo).map(lerMarcacao).sort(ordemDeLeitura);
}

export function marcar(db, materialId, { pagina, tipo, cor, retangulos, texto, nota }) {
  const arquivo = arquivoDe(db, materialId);
  const { paginas } = obterMaterial(db, materialId);
  const p = Math.floor(Number(pagina));
  if (!(p >= 1) || (paginas && p > paginas)) throw new Error(`Página ${pagina} fora do PDF.`);
  if (!TIPOS_MARCACAO.includes(tipo)) throw new Error(`Tipo de marcação desconhecido: ${tipo}.`);
  const { lastInsertRowid } = db.prepare(`INSERT INTO marcacao (arquivo, pagina, tipo, cor, retangulos, texto, nota)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(arquivo, p, tipo, validarCor(cor), JSON.stringify(validarRetangulos(retangulos)),
    textoLimpo(texto, 'O trecho') ?? '', notaLimpa(nota));
  return obterMarcacao(db, Number(lastInsertRowid));
}

// Muda cor, tipo (grifo e sublinhado trocam entre si) ou nota. Campo ausente fica como está.
export function editarMarcacao(db, id, { cor, tipo, nota } = {}) {
  const atual = obterMarcacao(db, id);
  if (tipo !== undefined && (atual.tipo === 'nota' || !['grifo', 'sublinhado'].includes(tipo))) {
    throw new Error('Só grifo e sublinhado trocam de tipo entre si.');
  }
  db.prepare('UPDATE marcacao SET cor = ?, tipo = ?, nota = ? WHERE id = ?').run(
    cor === undefined ? atual.cor : validarCor(cor),
    tipo ?? atual.tipo,
    nota === undefined ? atual.nota : notaLimpa(nota),
    id,
  );
  return obterMarcacao(db, id);
}

export function apagarMarcacao(db, id) {
  obterMarcacao(db, id);
  db.prepare('DELETE FROM marcacao WHERE id = ?').run(id);
}

// Para o Claude: marcações dos PDFs do plano, com o material e a matéria de cada uma.
export function marcacoesDoPlano(db, planoId, { materialId, materiaId } = {}) {
  if (!temArquivo(db)) return [];
  const filtros = ['mt.plano_id = ?'];
  const args = [planoId];
  if (materialId != null) {
    filtros.push('mt.id = ?');
    args.push(materialId);
  }
  if (materiaId != null) {
    filtros.push('mt.materia_id = ?');
    args.push(materiaId);
  }
  const linhas = db.prepare(`
    SELECT mc.id, mt.id AS material_id, mt.nome AS material, m.nome AS materia, mc.pagina, mc.tipo, mc.cor,
           mc.texto, mc.nota, mc.criado_em, mc.retangulos
    FROM marcacao mc JOIN material mt ON mt.arquivo = mc.arquivo LEFT JOIN materia m ON m.id = mt.materia_id
    WHERE ${filtros.join(' AND ')}
    ORDER BY m.posicao IS NULL, m.posicao, mt.pasta, mt.nome, mt.id`).all(...args).map(lerMarcacao);
  // Mantém a ordem dos materiais e põe cada um em ordem de leitura.
  const ordem = new Map();
  for (const l of linhas) if (!ordem.has(l.material_id)) ordem.set(l.material_id, ordem.size);
  return linhas.sort((a, b) => ordem.get(a.material_id) - ordem.get(b.material_id) || ordemDeLeitura(a, b));
}
