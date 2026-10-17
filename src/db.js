// Banco local: um arquivo SQLite por PC. O app e o servidor MCP abrem o mesmo arquivo,
// por isso o modo WAL e o busy_timeout.
// O banco mora FORA da pasta do programa: instalar, atualizar ou desinstalar o programa não toca nele.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CAMINHO_PADRAO = join(homedir(), 'Documents', 'App De Estudos', 'estudos.db');
const COPIAS_GUARDADAS = 30;

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

CREATE TABLE IF NOT EXISTS bloco (
  id INTEGER PRIMARY KEY,
  ciclo_id INTEGER NOT NULL REFERENCES ciclo(id) ON DELETE CASCADE,
  materia_id INTEGER NOT NULL REFERENCES materia(id) ON DELETE CASCADE,
  volta INTEGER NOT NULL DEFAULT 1,
  posicao INTEGER NOT NULL,
  duracao_min INTEGER NOT NULL,
  feito INTEGER NOT NULL DEFAULT 0
);

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

export function abrirBanco(caminho = CAMINHO_PADRAO) {
  if (caminho !== ':memory:') mkdirSync(dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(ESQUEMA);
  return db;
}

// Executa fn dentro de uma transação; desfaz tudo se algo falhar.
export function transacao(db, fn) {
  db.exec('BEGIN');
  try {
    const resultado = fn();
    db.exec('COMMIT');
    return resultado;
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
}
