// Banco local: um arquivo SQLite por PC. O app e o servidor MCP abrem o mesmo arquivo,
// por isso o modo WAL e o busy_timeout.
// O banco mora FORA da pasta do programa: instalar, atualizar ou desinstalar o programa não toca nele.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CAMINHO_PADRAO = join(homedir(), 'Documents', 'App De Estudos', 'estudos.db');
const COPIAS_GUARDADAS = 30;

// Datas locais em texto (YYYY-MM-DD), para agrupar por dia no fuso do PC.
export function dataLocal(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

// Cópia consistente do banco em <pasta do banco>/copias (VACUUM INTO funciona com o banco aberto).
// Guarda as 30 mais novas.
export function copiarBanco(db, caminho, motivo) {
  const pasta = join(dirname(caminho), 'copias');
  mkdirSync(pasta, { recursive: true });
  const z = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const carimbo = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  const destino = join(pasta, `estudos ${carimbo} ${motivo}.db`.replace(/[^\w .-]/g, '_'));
  if (!existsSync(destino)) db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  const todas = readdirSync(pasta).filter((f) => f.endsWith('.db')).sort();
  for (const velha of todas.slice(0, Math.max(0, todas.length - COPIAS_GUARDADAS))) rmSync(join(pasta, velha));
  return destino;
}

// Ao abrir o programa: copia antes de tudo se a versão mudou (atualização) ou se a última cópia
// tem mais de um dia. Devolve o caminho da cópia, ou null se não precisou.
export function copiaDeAbertura(db, caminho, versao) {
  if (caminho === ':memory:') return null;
  const pasta = join(dirname(caminho), 'copias');
  const anterior = db.prepare("SELECT valor FROM preferencia WHERE chave = 'versao_do_app'").get()?.valor;
  const ultima = existsSync(pasta)
    ? Math.max(0, ...readdirSync(pasta).filter((f) => f.endsWith('.db')).map((f) => statSync(join(pasta, f)).mtimeMs))
    : 0;
  let copia = null;
  if (anterior && anterior !== JSON.stringify(versao)) copia = copiarBanco(db, caminho, `antes da versao ${versao}`);
  else if (Date.now() - ultima > 24 * 3600 * 1000) copia = copiarBanco(db, caminho, 'diaria');
  db.prepare("INSERT INTO preferencia (chave, valor) VALUES ('versao_do_app', ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor")
    .run(JSON.stringify(versao));
  return copia;
}

// Bloco sem matéria é o de questões misturadas (1.1). Bancos da 1.0 têm materia_id NOT NULL e
// ganham a tabela nova em migrar(); o bloco é dado derivado, refeito do zero a cada gerarCiclo.
const COLUNAS_BLOCO = `
  id INTEGER PRIMARY KEY,
  ciclo_id INTEGER NOT NULL REFERENCES ciclo(id) ON DELETE CASCADE,
  materia_id INTEGER REFERENCES materia(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL DEFAULT 'teoria',
  volta INTEGER NOT NULL DEFAULT 1,
  posicao INTEGER NOT NULL,
  duracao_min INTEGER NOT NULL,
  feito INTEGER NOT NULL DEFAULT 0
`;

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS plano (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  data_prova TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS materia (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  cor TEXT,
  conhecimento REAL NOT NULL DEFAULT 2.5,
  importancia REAL NOT NULL DEFAULT 2.5,
  posicao INTEGER NOT NULL,
  UNIQUE (plano_id, nome)
);

CREATE TABLE IF NOT EXISTS topico (
  id INTEGER PRIMARY KEY,
  materia_id INTEGER NOT NULL REFERENCES materia(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  nome TEXT NOT NULL,
  concluido INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ciclo (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL UNIQUE REFERENCES plano(id) ON DELETE CASCADE,
  tempo_total_min INTEGER NOT NULL,
  bloco_min INTEGER NOT NULL,
  bloco_max INTEGER NOT NULL,
  passo_min INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bloco (${COLUNAS_BLOCO});

CREATE TABLE IF NOT EXISTS sessao (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  materia_id INTEGER REFERENCES materia(id) ON DELETE SET NULL,
  topico_id INTEGER REFERENCES topico(id) ON DELETE SET NULL,
  inicio TEXT NOT NULL,
  duracao_min INTEGER NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('teoria', 'questoes', 'revisao')),
  acertos INTEGER NOT NULL DEFAULT 0,
  erros INTEGER NOT NULL DEFAULT 0,
  anotacao TEXT,
  origem TEXT NOT NULL DEFAULT 'app' CHECK (origem IN ('app', 'claude'))
);

CREATE TABLE IF NOT EXISTS revisao (
  id INTEGER PRIMARY KEY,
  sessao_id INTEGER NOT NULL REFERENCES sessao(id) ON DELETE CASCADE,
  data_prevista TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'feita', 'pulada'))
);

CREATE TABLE IF NOT EXISTS preferencia (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

INSERT OR IGNORE INTO preferencia (chave, valor) VALUES
  ('intervalos_revisao', '[1,7,30,60,120]'),
  ('minutos_constancia', '20');
`;

// Versão 1.1: fases com data, lotes de questões reservados e simulados.
const ESQUEMA_1_1 = `
CREATE TABLE IF NOT EXISTS fase (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  inicio TEXT NOT NULL,
  fim TEXT NOT NULL,
  minutos_por_volta INTEGER,
  teto_semanal_min INTEGER,
  questoes_mistas_min INTEGER,
  anotacao TEXT,
  UNIQUE (plano_id, nome)
);

CREATE TABLE IF NOT EXISTS fase_materia (
  fase_id INTEGER NOT NULL REFERENCES fase(id) ON DELETE CASCADE,
  materia_id INTEGER NOT NULL REFERENCES materia(id) ON DELETE CASCADE,
  peso REAL,
  tipo TEXT NOT NULL DEFAULT 'teoria' CHECK (tipo IN ('teoria', 'revisao', 'questoes')),
  fora INTEGER NOT NULL DEFAULT 0,
  grupo_foco TEXT,
  PRIMARY KEY (fase_id, materia_id)
);

CREATE TABLE IF NOT EXISTS lote_reservado (
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  origem TEXT NOT NULL,
  libera_em TEXT,
  PRIMARY KEY (plano_id, origem)
);

CREATE TABLE IF NOT EXISTS simulado (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  feito_em TEXT NOT NULL,
  minutos INTEGER NOT NULL,
  questoes INTEGER NOT NULL,
  acertos INTEGER NOT NULL,
  por_materia TEXT NOT NULL,
  lote TEXT
);
`;

// Colunas que entraram depois da 1.0; bancos antigos ganham as colunas sem perder nada.
const COLUNAS_NOVAS = {
  ciclo: { fase_id: 'INTEGER', total_base_min: 'INTEGER' },
  materia: { meta_acerto: 'REAL' },
  plano: { modo_semana: "TEXT NOT NULL DEFAULT 'meta'", teto_semanal_min: 'INTEGER' },
};

export const colunasDe = (db, tabela) => new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));

// Só acrescenta: tabela nova, coluna nova, e a tabela bloco (derivada) com materia_id opcional.
// Banco aberto só para leitura fica como está; o app atualiza na próxima vez que abrir.
function migrar(db) {
  try {
    db.exec(ESQUEMA_1_1);
    for (const [tabela, colunas] of Object.entries(COLUNAS_NOVAS)) {
      const existentes = colunasDe(db, tabela);
      for (const [coluna, tipo] of Object.entries(colunas)) {
        if (!existentes.has(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
      }
    }
    if (!colunasDe(db, 'bloco').has('tipo')) {
      transacao(db, () => {
        db.exec(`CREATE TABLE bloco_novo (${COLUNAS_BLOCO});
          INSERT INTO bloco_novo (id, ciclo_id, materia_id, volta, posicao, duracao_min, feito)
            SELECT id, ciclo_id, materia_id, volta, posicao, duracao_min, feito FROM bloco;
          DROP TABLE bloco;
          ALTER TABLE bloco_novo RENAME TO bloco;`);
      });
    }
  } catch (erro) {
    if (!/readonly/i.test(erro.message)) throw erro;
  }
}

export function abrirBanco(caminho = CAMINHO_PADRAO) {
  if (caminho !== ':memory:') mkdirSync(dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(ESQUEMA);
  migrar(db);
  return db;
}

// Executa fn dentro de uma transação; desfaz tudo se algo falhar. Usa savepoint para poder
// aninhar (o simulado grava estudos com registrarSessao, que tem a própria transação).
let savepoints = 0;
export function transacao(db, fn) {
  const nome = `t${++savepoints}`;
  db.exec(`SAVEPOINT ${nome}`);
  try {
    const resultado = fn();
    db.exec(`RELEASE ${nome}`);
    return resultado;
  } catch (erro) {
    db.exec(`ROLLBACK TO ${nome}; RELEASE ${nome}`);
    throw erro;
  }
}
