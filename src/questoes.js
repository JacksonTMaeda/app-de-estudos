// Banco de questões: importa os quizzes em HTML do cofre e guarda as respostas.
// Os quizzes trazem as questões num array JavaScript (var Q = [...] ou const QUESTIONS = [...]),
// com nomes de campo que mudaram ao longo do tempo; normalizar() aceita todos.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import vm from 'node:vm';
import { dataLocal, transacao } from './db.js';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS questao (
  id INTEGER PRIMARY KEY,
  plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE,
  materia_id INTEGER REFERENCES materia(id) ON DELETE SET NULL,
  origem TEXT NOT NULL,
  numero INTEGER NOT NULL,
  fonte TEXT,
  tema TEXT,
  enunciado TEXT NOT NULL,
  alternativas TEXT NOT NULL,
  correta INTEGER NOT NULL,
  comentario TEXT,
  UNIQUE (plano_id, origem, numero)
);
CREATE TABLE IF NOT EXISTS resposta (
  id INTEGER PRIMARY KEY,
  questao_id INTEGER NOT NULL REFERENCES questao(id) ON DELETE CASCADE,
  escolhida INTEGER NOT NULL,
  acertou INTEGER NOT NULL,
  respondida_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  segundos INTEGER,
  causa TEXT CHECK (causa IN ('conceito', 'decoreba', 'leitura', 'tempo', 'chute'))
);
`;

// Causa do erro, marcada logo depois de errar. É o dado que diz o que estudar.
export const CAUSAS = {
  conceito: 'Não sabia o conteúdo',
  decoreba: 'Esqueci número, prazo ou lista',
  leitura: 'Li errado o enunciado',
  tempo: 'Pressa ou falta de tempo',
  chute: 'Chutei',
};

// Colunas que entraram depois da primeira versão; bancos antigos ganham as colunas sem perder nada.
const COLUNAS_NOVAS = { resposta: { segundos: 'INTEGER', causa: 'TEXT' } };

export function prepararQuestoes(db) {
  db.exec(ESQUEMA);
  for (const [tabela, colunas] of Object.entries(COLUNAS_NOVAS)) {
    const existentes = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
    for (const [coluna, tipo] of Object.entries(colunas)) {
      if (existentes.has(coluna)) continue;
      try {
        db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
      } catch (erro) {
        // Aberto só para leitura (servidor MCP): o app atualiza o banco na próxima vez que abrir.
        if (!/readonly/i.test(erro.message)) throw erro;
      }
    }
  }
}

// Acha o primeiro array de objetos atribuído a uma variável e devolve o texto dele,
// casando colchetes fora de strings e comentários.
export function extrairArray(fonte) {
  const inicio = fonte.search(/\b(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*\[\s*\{/);
  if (inicio < 0) return null;
  const abre = fonte.indexOf('[', inicio);
  let nivel = 0;
  let aspas = null;
  for (let i = abre; i < fonte.length; i++) {
    const c = fonte[i];
    if (aspas) {
      if (c === '\\') i++;
      else if (c === aspas) aspas = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') aspas = c;
    else if (c === '/' && fonte[i + 1] === '/') i = fonte.indexOf('\n', i) - 1;
    else if (c === '/' && fonte[i + 1] === '*') i = fonte.indexOf('*/', i) + 1;
    else if (c === '[') nivel++;
    else if (c === ']' && --nivel === 0) return fonte.slice(abre, i + 1);
  }
  return null;
}

const primeiro = (obj, chaves) => chaves.map((k) => obj[k]).find((v) => v !== undefined && v !== null);

function indiceDaCorreta(valor, total) {
  if (typeof valor === 'number') return valor;
  if (typeof valor === 'string') {
    const letra = 'abcde'.indexOf(valor.trim().toLowerCase().replace(/[^a-e]/g, ''));
    if (letra >= 0) return letra;
    if (/^\d+$/.test(valor)) return Number(valor);
  }
  return valor >= 0 && valor < total ? valor : -1;
}

export function normalizar(bruta, i) {
  const alternativas = primeiro(bruta, ['alts', 'opts', 'options', 'alternativas', 'opcoes']);
  const enunciado = primeiro(bruta, ['en', 'stem', 'enunciado', 'pergunta', 'q', 'question']);
  if (!Array.isArray(alternativas) || alternativas.length < 2 || !enunciado) return null;
  const correta = indiceDaCorreta(primeiro(bruta, ['c', 'correct', 'correta', 'answer', 'gabarito']), alternativas.length);
  if (!(correta >= 0 && correta < alternativas.length)) return null;
  return {
    numero: Number(primeiro(bruta, ['n', 'numero', 'id']) ?? i + 1),
    fonte: primeiro(bruta, ['fonte', 'banca', 'source']) ?? null,
    tema: primeiro(bruta, ['tema', 'topic', 'assunto']) ?? null,
    enunciado: String(enunciado),
    alternativas: alternativas.map(String),
    correta,
    comentario: primeiro(bruta, ['com', 'exp', 'comentario', 'explicacao', 'explanation']) ?? null,
  };
}

// O array vem de arquivo do próprio usuário, mas roda isolado: sem acesso a nada e com tempo limite.
export function lerQuiz(html) {
  const texto = extrairArray(html);
  if (!texto) return [];
  let lista;
  try {
    lista = vm.runInNewContext(`(${texto})`, Object.create(null), { timeout: 1000 });
  } catch {
    return [];
  }
  if (!Array.isArray(lista)) return [];
  return lista.map(normalizar).filter(Boolean);
}

const semAcento = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const palavras = (t) => new Set(semAcento(t).split(/[^a-z0-9]+/).filter((p) => p.length > 3));

// Casa o nome da pasta com a matéria do plano pela maior sobreposição de palavras.
export function materiaDaPasta(pasta, materias) {
  const alvo = palavras(pasta);
  let melhor = null;
  let pontos = 0;
  for (const m of materias) {
    const comuns = [...palavras(m.nome)].filter((p) => alvo.has(p)).length;
    if (comuns > pontos) [melhor, pontos] = [m, comuns];
  }
  return melhor;
}

function arquivosHtml(pasta) {
  return readdirSync(pasta).flatMap((nome) => {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) return arquivosHtml(caminho);
    return nome.toLowerCase().endsWith('.html') ? [caminho] : [];
  });
}

// Importa todos os quizzes de uma pasta. Reimportar não duplica: a chave é arquivo + número.
export function importarPasta(db, planoId, pasta) {
  prepararQuestoes(db);
  const materias = db.prepare('SELECT id, nome FROM materia WHERE plano_id = ?').all(planoId);
  const inserir = db.prepare(
    `INSERT INTO questao (plano_id, materia_id, origem, numero, fonte, tema, enunciado, alternativas, correta, comentario)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (plano_id, origem, numero) DO UPDATE SET
       materia_id = excluded.materia_id, fonte = excluded.fonte, tema = excluded.tema, enunciado = excluded.enunciado,
       alternativas = excluded.alternativas, correta = excluded.correta, comentario = excluded.comentario`,
  );
  const relatorio = [];
  transacao(db, () => {
    for (const arquivo of arquivosHtml(pasta)) {
      const questoes = lerQuiz(readFileSync(arquivo, 'utf8'));
      if (questoes.length === 0) continue;
      const partes = relative(pasta, arquivo).split(sep);
      const materia = materiaDaPasta(partes.length > 1 ? partes[0] : basename(arquivo), materias);
      const origem = relative(pasta, arquivo).split(sep).join('/');
      for (const q of questoes) {
        inserir.run(planoId, materia?.id ?? null, origem, q.numero, q.fonte, q.tema, q.enunciado,
          JSON.stringify(q.alternativas), q.correta, q.comentario);
      }
      relatorio.push({ arquivo: origem, questoes: questoes.length, materia: materia?.nome ?? null });
    }
  });
  return relatorio;
}

// Questão é "de banca" quando a fonte cita uma banca; o resto é autoral (gerada pelo Claude).
const DE_BANCA = "(q.fonte IS NOT NULL AND q.fonte <> '' AND lower(q.fonte) NOT LIKE '%autoral%')";

// Bancas presentes no banco, pela primeira parte da fonte ("FGV / PC-MG / 2025" vira FGV).
export function listarBancas(db, planoId) {
  prepararQuestoes(db);
  const contagem = new Map();
  for (const { fonte } of db.prepare(`SELECT q.fonte FROM questao q WHERE q.plano_id = ? AND ${DE_BANCA}`).all(planoId)) {
    const banca = fonte.split('/')[0].trim();
    contagem.set(banca, (contagem.get(banca) || 0) + 1);
  }
  return [...contagem].map(([banca, total]) => ({ banca, total })).sort((a, b) => b.total - a.total);
}

const temLotesReservados = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lote_reservado'").get();

// Lote reservado e ainda não liberado: fora das rodadas comuns e do bloco misturado.
const RESERVADO = `EXISTS (SELECT 1 FROM lote_reservado l WHERE l.plano_id = q.plano_id AND l.origem = q.origem
  AND (l.libera_em IS NULL OR l.libera_em > ?))`;

// origem: 'todas', 'banca', 'autoral' ou o nome de uma banca (ex.: 'FGV').
// lote: só as questões desse lote (campo origem), reservado ou não. Sem lote, os reservados ficam de fora,
// a não ser com incluirReservados (simulado). aleatoria embaralha antes do limite.
export function listarQuestoes(db, planoId, {
  materiaId = null, origem = 'todas', situacao = 'todas', ids = null, limite = 200,
  lote = null, incluirReservados = false, aleatoria = false, hoje = dataLocal(),
} = {}) {
  prepararQuestoes(db);
  const filtros = ['q.plano_id = ?'];
  const args = [planoId];
  if (lote) {
    filtros.push('q.origem = ?');
    args.push(lote);
  } else if (!incluirReservados && !Array.isArray(ids) && temLotesReservados(db)) {
    filtros.push(`NOT ${RESERVADO}`);
    args.push(hoje);
  }
  if (Array.isArray(ids)) {
    filtros.push(`q.id IN (${ids.map(() => '?').join(',') || 'NULL'})`);
    args.push(...ids.map(Number));
  }
  if (materiaId) {
    filtros.push('q.materia_id = ?');
    args.push(materiaId);
  }
  if (origem === 'banca') filtros.push(DE_BANCA);
  else if (origem === 'autoral') filtros.push(`NOT ${DE_BANCA}`);
  else if (origem && origem !== 'todas') {
    filtros.push(`${DE_BANCA} AND (q.fonte = ? OR q.fonte LIKE ? || ' /%')`);
    args.push(origem, origem);
  }
  if (situacao === 'nao_respondidas') filtros.push('u.acertou IS NULL');
  if (situacao === 'erradas') filtros.push('u.acertou = 0');
  args.push(limite);
  return db
    .prepare(
      `WITH ultima AS (
         SELECT questao_id, acertou, MAX(id) FROM resposta GROUP BY questao_id
       )
       SELECT q.id, q.materia_id, m.nome materia, q.origem, q.numero, q.fonte, q.tema, q.enunciado,
              q.alternativas, q.correta, q.comentario, u.acertou ultima_acertou
       FROM questao q LEFT JOIN materia m ON m.id = q.materia_id LEFT JOIN ultima u ON u.questao_id = q.id
       WHERE ${filtros.join(' AND ')}
       ORDER BY ${aleatoria ? 'random()' : 'm.posicao, q.origem, q.numero'} LIMIT ?`,
    )
    .all(...args)
    .map((q) => ({ ...q, alternativas: JSON.parse(q.alternativas) }));
}

export function responderQuestao(db, questaoId, escolhida, segundos = null) {
  prepararQuestoes(db);
  const q = db.prepare('SELECT correta FROM questao WHERE id = ?').get(questaoId);
  if (!q) throw new Error(`Questão ${questaoId} não existe.`);
  const acertou = q.correta === escolhida ? 1 : 0;
  const tempo = Number.isFinite(segundos) && segundos >= 0 ? Math.round(segundos) : null;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO resposta (questao_id, escolhida, acertou, segundos) VALUES (?, ?, ?, ?)')
    .run(questaoId, escolhida, acertou, tempo);
  return { respostaId: Number(lastInsertRowid), acertou: !!acertou, correta: q.correta };
}

// Acrescenta questões avulsas (geradas pelo Claude, por exemplo). origem agrupa o lote, como um arquivo de quiz.
export function adicionarQuestoes(db, planoId, { origem, materiaId = null, questoes }) {
  prepararQuestoes(db);
  const normalizadas = questoes.map((q, i) => normalizar(q, i));
  const invalida = normalizadas.findIndex((q) => !q);
  if (invalida >= 0) throw new Error(`Questão ${invalida + 1} inválida: precisa de enunciado, 2 ou mais alternativas e gabarito dentro delas.`);
  const proximo = db.prepare('SELECT COALESCE(MAX(numero), 0) n FROM questao WHERE plano_id = ? AND origem = ?').get(planoId, origem).n;
  const inserir = db.prepare(
    `INSERT INTO questao (plano_id, materia_id, origem, numero, fonte, tema, enunciado, alternativas, correta, comentario)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return transacao(db, () =>
    normalizadas.map((q, i) =>
      Number(inserir.run(planoId, materiaId, origem, proximo + i + 1, q.fonte, q.tema, q.enunciado,
        JSON.stringify(q.alternativas), q.correta, q.comentario).lastInsertRowid),
    ),
  );
}

export function apagarQuestao(db, questaoId) {
  prepararQuestoes(db);
  db.prepare('DELETE FROM questao WHERE id = ?').run(questaoId);
}

// Só resposta errada tem causa; null desmarca.
export function marcarCausa(db, respostaId, causa) {
  if (causa !== null && !Object.hasOwn(CAUSAS, causa)) throw new Error(`Causa desconhecida: ${causa}`);
  db.prepare('UPDATE resposta SET causa = ? WHERE id = ? AND acertou = 0').run(causa, respostaId);
}

export function resumoQuestoes(db, planoId) {
  prepararQuestoes(db);
  return db
    .prepare(
      `SELECT m.id materia_id, m.nome materia, COUNT(DISTINCT q.id) total,
              COUNT(DISTINCT r.questao_id) respondidas,
              COALESCE(SUM(r.acertou), 0) acertos, COUNT(r.id) respostas
       FROM questao q LEFT JOIN materia m ON m.id = q.materia_id LEFT JOIN resposta r ON r.questao_id = q.id
       WHERE q.plano_id = ? GROUP BY q.materia_id ORDER BY m.posicao`,
    )
    .all(planoId);
}

// Lotes de questões do plano (o campo origem), com quantas questões e se estão reservados.
export function listarLotes(db, planoId, hoje = dataLocal()) {
  prepararQuestoes(db);
  const reservas = temLotesReservados(db)
    ? new Map(db.prepare('SELECT origem, libera_em FROM lote_reservado WHERE plano_id = ?').all(planoId).map((r) => [r.origem, r]))
    : new Map();
  return db
    .prepare('SELECT origem lote, COUNT(*) questoes FROM questao WHERE plano_id = ? GROUP BY origem ORDER BY origem')
    .all(planoId)
    .map((l) => {
      const r = reservas.get(l.lote);
      return { ...l, reservado: !!r && (r.libera_em == null || r.libera_em > hoje), libera_em: r?.libera_em ?? null };
    });
}

// Acha o lote pelo nome exato, pelo nome que o Claude deu (gravado como "claude/<nome>") ou sem diferença de maiúsculas.
export function acharLote(db, planoId, nome) {
  const lotes = listarLotes(db, planoId).map((l) => l.lote);
  const alvo = String(nome).trim();
  const achado = lotes.find((l) => l === alvo) ?? lotes.find((l) => l === `claude/${alvo}`)
    ?? lotes.find((l) => l.toLowerCase() === alvo.toLowerCase() || l.toLowerCase() === `claude/${alvo}`.toLowerCase());
  if (!achado) throw new Error(`Lote "${nome}" não encontrado. Lotes: ${lotes.join('; ') || 'nenhum'}.`);
  return achado;
}

// Reserva (com data de liberação opcional, YYYY-MM-DD) ou libera um lote.
export function reservarLote(db, planoId, lote, { reservado = true, liberaEm = null } = {}) {
  const origem = acharLote(db, planoId, lote);
  if (liberaEm && !/^\d{4}-\d{2}-\d{2}$/.test(liberaEm)) throw new Error('Data de liberação em YYYY-MM-DD.');
  if (reservado) {
    db.prepare(
      `INSERT INTO lote_reservado (plano_id, origem, libera_em) VALUES (?, ?, ?)
       ON CONFLICT (plano_id, origem) DO UPDATE SET libera_em = excluded.libera_em`,
    ).run(planoId, origem, liberaEm || null);
  } else {
    db.prepare('DELETE FROM lote_reservado WHERE plano_id = ? AND origem = ?').run(planoId, origem);
  }
  return listarLotes(db, planoId).find((l) => l.lote === origem);
}
