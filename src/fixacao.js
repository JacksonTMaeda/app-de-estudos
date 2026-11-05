// Fixação: flashcards e mapas mentais. O Claude escreve (pelo servidor MCP), a pessoa só consulta na tela.
// Sem agenda, sem certo ou errado: o cartão só guarda quantas vezes foi visto.
import { transacao } from './db.js';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS flashcard (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  materia_id INTEGER REFERENCES materia(id) ON DELETE SET NULL,
  material_id INTEGER,
  pagina_de INTEGER,
  pagina_ate INTEGER,
  baralho TEXT NOT NULL,
  frente TEXT NOT NULL,
  verso TEXT NOT NULL,
  criado_em TEXT DEFAULT (datetime('now', 'localtime')),
  vezes_visto INTEGER DEFAULT 0,
  visto_em TEXT
);
CREATE TABLE IF NOT EXISTS mapa_mental (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  materia_id INTEGER REFERENCES materia(id) ON DELETE SET NULL,
  material_id INTEGER,
  pagina_de INTEGER,
  pagina_ate INTEGER,
  titulo TEXT NOT NULL,
  arvore TEXT NOT NULL,
  criado_em TEXT DEFAULT (datetime('now', 'localtime'))
);
`;

export const LIMITES_MAPA = { niveis: 6, nos: 300, texto: 200, nota: 500 };

export function prepararFixacao(db) {
  try {
    db.exec(ESQUEMA);
  } catch (erro) {
    // Aberto só para leitura (servidor MCP): o app cria as tabelas na próxima vez que abrir.
    if (!/readonly/i.test(erro.message)) throw erro;
  }
}

const inteiroOuNulo = (v) => (v === undefined || v === null || v === '' ? null : Math.trunc(Number(v)) || null);
const textoLimpo = (v) => String(v ?? '').trim();

export function adicionarFlashcards(db, planoId, { baralho, materiaId = null, materialId = null, paginaDe = null, paginaAte = null, cartoes }) {
  prepararFixacao(db);
  const nome = textoLimpo(baralho);
  if (!nome) throw new Error('O baralho precisa de um nome.');
  if (!Array.isArray(cartoes) || cartoes.length === 0) throw new Error('Informe ao menos um cartão.');
  const invalido = cartoes.findIndex((c) => !textoLimpo(c?.frente) || !textoLimpo(c?.verso));
  if (invalido >= 0) throw new Error(`Cartão ${invalido + 1} inválido: precisa de frente e verso com texto.`);
  const inserir = db.prepare(
    `INSERT INTO flashcard (plano_id, materia_id, material_id, pagina_de, pagina_ate, baralho, frente, verso)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return transacao(db, () =>
    cartoes.map((c) =>
      Number(inserir.run(planoId, materiaId ?? null, inteiroOuNulo(materialId), inteiroOuNulo(paginaDe), inteiroOuNulo(paginaAte),
        nome, textoLimpo(c.frente), textoLimpo(c.verso)).lastInsertRowid),
    ),
  );
}

export function listarBaralhos(db, planoId, { materiaId = null } = {}) {
  prepararFixacao(db);
  const args = [planoId];
  let filtro = '';
  if (materiaId) {
    filtro = 'AND f.materia_id = ?';
    args.push(materiaId);
  }
  return db
    .prepare(
      `SELECT f.baralho, f.materia_id, m.nome materia, MIN(f.material_id) material_id, MIN(f.pagina_de) pagina_de,
              MAX(f.pagina_ate) pagina_ate, COUNT(*) cartoes, MIN(substr(f.criado_em, 1, 10)) criado_em
       FROM flashcard f LEFT JOIN materia m ON m.id = f.materia_id
       WHERE f.plano_id = ? ${filtro}
       GROUP BY f.baralho, f.materia_id ORDER BY MAX(f.id) DESC`,
    )
    .all(...args);
}

export function listarFlashcards(db, planoId, { materiaId = null, baralho = null, aleatorio = false, limite = 500 } = {}) {
  prepararFixacao(db);
  const filtros = ['f.plano_id = ?'];
  const args = [planoId];
  if (materiaId) {
    filtros.push('f.materia_id = ?');
    args.push(materiaId);
  }
  if (baralho) {
    filtros.push('f.baralho = ?');
    args.push(baralho);
  }
  args.push(Math.max(1, Number(limite) || 500));
  return db
    .prepare(
      `SELECT f.id, f.baralho, f.materia_id, m.nome materia, f.material_id, f.pagina_de, f.pagina_ate,
              f.frente, f.verso, f.criado_em, f.vezes_visto, f.visto_em
       FROM flashcard f LEFT JOIN materia m ON m.id = f.materia_id
       WHERE ${filtros.join(' AND ')} ORDER BY ${aleatorio ? 'random()' : 'f.id'} LIMIT ?`,
    )
    .all(...args);
}

export function marcarVisto(db, id) {
  prepararFixacao(db);
  db.prepare("UPDATE flashcard SET vezes_visto = COALESCE(vezes_visto, 0) + 1, visto_em = datetime('now', 'localtime') WHERE id = ?").run(Number(id));
}

export function apagarFlashcard(db, id) {
  prepararFixacao(db);
  return Number(db.prepare('DELETE FROM flashcard WHERE id = ?').run(Number(id)).changes);
}

export function apagarBaralho(db, planoId, baralho) {
  prepararFixacao(db);
  return Number(db.prepare('DELETE FROM flashcard WHERE plano_id = ? AND baralho = ?').run(planoId, baralho).changes);
}

// Valida e limpa a árvore: devolve uma cópia só com texto, nota e filhos.
export function validarArvore(arvore) {
  const { niveis, nos, texto, nota } = LIMITES_MAPA;
  if (!arvore || typeof arvore !== 'object' || Array.isArray(arvore)) throw new Error('A árvore precisa ser um objeto com texto e filhos.');
  let total = 0;
  const visitar = (no, nivel, caminho) => {
    if (!no || typeof no !== 'object' || Array.isArray(no)) throw new Error(`Nó inválido em ${caminho}: precisa ser um objeto.`);
    const t = textoLimpo(no.texto);
    if (!t) throw new Error(nivel === 1 ? 'A raiz da árvore precisa de texto.' : `Nó sem texto em ${caminho}.`);
    if (nivel > niveis) throw new Error(`A árvore passa de ${niveis} níveis (em ${caminho}).`);
    if (++total > nos) throw new Error(`A árvore passa de ${nos} nós.`);
    if (t.length > texto) throw new Error(`Texto com mais de ${texto} caracteres em ${caminho}.`);
    const n = no.nota == null ? '' : textoLimpo(no.nota);
    if (n.length > nota) throw new Error(`Nota com mais de ${nota} caracteres em ${caminho}.`);
    if (no.filhos != null && !Array.isArray(no.filhos)) throw new Error(`"filhos" precisa ser uma lista em ${caminho}.`);
    const limpo = { texto: t };
    if (n) limpo.nota = n;
    limpo.filhos = (no.filhos ?? []).map((f, i) => visitar(f, nivel + 1, `${caminho} > filho ${i + 1}`));
    return limpo;
  };
  return visitar(arvore, 1, 'raiz');
}

export function salvarMapa(db, planoId, { id = null, titulo, materiaId = null, materialId = null, paginaDe = null, paginaAte = null, arvore }) {
  prepararFixacao(db);
  const nome = textoLimpo(titulo);
  if (!nome) throw new Error('O mapa precisa de um título.');
  let bruta = arvore;
  if (typeof bruta === 'string') {
    try {
      bruta = JSON.parse(bruta);
    } catch {
      throw new Error('A árvore veio como texto que não é JSON válido.');
    }
  }
  const json = JSON.stringify(validarArvore(bruta));
  const campos = [materiaId ?? null, inteiroOuNulo(materialId), inteiroOuNulo(paginaDe), inteiroOuNulo(paginaAte), nome, json];
  if (id != null) {
    const r = db
      .prepare('UPDATE mapa_mental SET materia_id = ?, material_id = ?, pagina_de = ?, pagina_ate = ?, titulo = ?, arvore = ? WHERE id = ? AND plano_id = ?')
      .run(...campos, Number(id), planoId);
    if (!r.changes) throw new Error(`Mapa ${id} não existe neste plano.`);
    return Number(id);
  }
  return Number(
    db.prepare('INSERT INTO mapa_mental (materia_id, material_id, pagina_de, pagina_ate, titulo, arvore, plano_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(...campos, planoId).lastInsertRowid,
  );
}

export function listarMapas(db, planoId, { materiaId = null } = {}) {
  prepararFixacao(db);
  const args = [planoId];
  let filtro = '';
  if (materiaId) {
    filtro = 'AND p.materia_id = ?';
    args.push(materiaId);
  }
  return db
    .prepare(
      `SELECT p.id, p.titulo, p.materia_id, m.nome materia, p.material_id, p.pagina_de, p.pagina_ate, p.criado_em
       FROM mapa_mental p LEFT JOIN materia m ON m.id = p.materia_id
       WHERE p.plano_id = ? ${filtro} ORDER BY p.id DESC`,
    )
    .all(...args);
}

export function lerMapa(db, id) {
  prepararFixacao(db);
  const p = db
    .prepare(
      `SELECT p.id, p.plano_id, p.titulo, p.materia_id, m.nome materia, p.material_id, p.pagina_de, p.pagina_ate, p.criado_em, p.arvore
       FROM mapa_mental p LEFT JOIN materia m ON m.id = p.materia_id WHERE p.id = ?`,
    )
    .get(Number(id));
  if (!p) throw new Error(`Mapa ${id} não existe.`);
  return { ...p, arvore: JSON.parse(p.arvore) };
}

export function apagarMapa(db, id) {
  prepararFixacao(db);
  return Number(db.prepare('DELETE FROM mapa_mental WHERE id = ?').run(Number(id)).changes);
}
