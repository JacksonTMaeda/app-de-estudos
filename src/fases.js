// Fases com data (1.1): um plano pode ter etapas, cada uma com peso manual, tipo de bloco,
// matérias fora e grupo de foco por matéria. Plano sem fase segue o ciclo do Estudei como sempre.
// O ciclo é refeito na virada de fase por sincronizarFase (ciclo.js).
import { dataLocal, transacao } from './db.js';

export const TIPOS_BLOCO = ['teoria', 'revisao', 'questoes'];
const DATA = /^\d{4}-\d{2}-\d{2}$/;

// Banco ainda não migrado (aberto só para leitura): sem fases, ciclo padrão.
const temFases = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fase'").get();

function materiasDaFase(db, fase) {
  return db
    .prepare(
      `SELECT m.id materia_id, m.nome materia, fm.peso, COALESCE(fm.tipo, 'teoria') tipo,
              COALESCE(fm.fora, 0) fora, fm.grupo_foco
       FROM materia m LEFT JOIN fase_materia fm ON fm.materia_id = m.id AND fm.fase_id = ?
       WHERE m.plano_id = ? ORDER BY m.posicao`,
    )
    .all(fase.id, fase.plano_id)
    .map((m) => ({ ...m, fora: !!m.fora }));
}

const comMaterias = (db, fase) => fase && { ...fase, materias: materiasDaFase(db, fase) };

export function listarFases(db, planoId) {
  if (!temFases(db)) return [];
  return db.prepare('SELECT * FROM fase WHERE plano_id = ? ORDER BY inicio').all(planoId).map((f) => comMaterias(db, f));
}

// A fase que contém a data (padrão: hoje), ou null.
export function faseAtiva(db, planoId, hoje = dataLocal()) {
  if (!temFases(db)) return null;
  return comMaterias(db, db.prepare('SELECT * FROM fase WHERE plano_id = ? AND inicio <= ? AND fim >= ?').get(planoId, hoje, hoje));
}

export function proximaFase(db, planoId, hoje = dataLocal()) {
  if (!temFases(db)) return null;
  return db.prepare('SELECT * FROM fase WHERE plano_id = ? AND inicio > ? ORDER BY inicio LIMIT 1').get(planoId, hoje) ?? null;
}

export function faseDoCiclo(db, faseId) {
  if (faseId == null || !temFases(db)) return null;
  return comMaterias(db, db.prepare('SELECT * FROM fase WHERE id = ?').get(faseId));
}

// Os números do Estudei e os manuais não estão na mesma escala: ou todas as matérias ativas têm peso, ou nenhuma.
export function conferirPesos(materias) {
  const ativas = materias.filter((m) => !m.fora);
  if (ativas.length === 0) throw new Error('A fase precisa de pelo menos uma matéria ativa (fora = false).');
  const sem = ativas.filter((m) => m.peso == null);
  if (sem.length > 0 && sem.length < ativas.length) {
    throw new Error(
      `Peso manual precisa valer para todas as matérias ativas da fase. Faltou em: ${sem.map((m) => m.materia).join('; ')}. ` +
        'Dê peso a elas, marque como fora da fase ou tire o peso de todas.',
    );
  }
}

const inteiroOuNulo = (v, nome) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${nome} precisa ser um número de minutos maior que zero.`);
  return n;
};

// Cria ou atualiza pelo nome. Campo não enviado mantém o valor que já tinha; materias, quando enviada,
// substitui a configuração inteira (matéria fora da lista volta ao padrão: sem peso, teoria, dentro da fase).
// Cada item de materias: { materia_id, peso, tipo, fora, grupo_foco }.
export function definirFase(db, planoId, dados) {
  const nome = String(dados.nome ?? '').trim();
  if (!nome) throw new Error('A fase precisa de nome.');
  const antiga = db.prepare('SELECT * FROM fase WHERE plano_id = ? AND nome = ?').get(planoId, nome);
  const valor = (campo) => (dados[campo] === undefined ? antiga?.[campo] ?? null : dados[campo]);
  const inicio = valor('inicio');
  const fim = valor('fim');
  if (!DATA.test(inicio ?? '') || !DATA.test(fim ?? '')) throw new Error('Início e fim da fase em YYYY-MM-DD.');
  if (inicio > fim) throw new Error('O início da fase vem depois do fim.');
  const sobreposta = db
    .prepare('SELECT nome, inicio, fim FROM fase WHERE plano_id = ? AND nome <> ? AND inicio <= ? AND fim >= ?')
    .get(planoId, nome, fim, inicio);
  if (sobreposta) throw new Error(`A fase se sobrepõe à fase "${sobreposta.nome}" (${sobreposta.inicio} a ${sobreposta.fim}).`);

  const campos = {
    minutos_por_volta: inteiroOuNulo(valor('minutos_por_volta'), 'Minutos por volta'),
    teto_semanal_min: inteiroOuNulo(valor('teto_semanal_min'), 'Teto semanal'),
    questoes_mistas_min: inteiroOuNulo(valor('questoes_mistas_min'), 'Questões misturadas'),
    anotacao: valor('anotacao') || null,
  };

  const materiasDoPlano = db.prepare('SELECT id, nome FROM materia WHERE plano_id = ?').all(planoId);
  let config = null;
  if (dados.materias !== undefined) {
    config = new Map();
    for (const item of dados.materias) {
      const m = materiasDoPlano.find((x) => x.id === Number(item.materia_id));
      if (!m) throw new Error(`Matéria ${item.materia_id} não é deste plano.`);
      const tipo = item.tipo ?? 'teoria';
      if (!TIPOS_BLOCO.includes(tipo)) throw new Error(`Tipo "${tipo}" inválido: use teoria, revisao ou questoes.`);
      const peso = item.peso === undefined || item.peso === null ? null : Number(item.peso);
      if (peso !== null && !(peso > 0)) throw new Error(`Peso de ${m.nome} precisa ser maior que zero.`);
      config.set(m.id, { materia_id: m.id, materia: m.nome, peso, tipo, fora: !!item.fora, grupo_foco: item.grupo_foco?.trim() || null });
    }
  } else if (antiga) {
    config = new Map(materiasDaFase(db, antiga).map((m) => [m.materia_id, m]));
  }
  const todas = materiasDoPlano.map((m) => config?.get(m.id) ?? { materia_id: m.id, materia: m.nome, peso: null, tipo: 'teoria', fora: false });
  conferirPesos(todas);

  return transacao(db, () => {
    let faseId = antiga?.id;
    if (antiga) {
      db.prepare(
        `UPDATE fase SET inicio = ?, fim = ?, minutos_por_volta = ?, teto_semanal_min = ?, questoes_mistas_min = ?, anotacao = ? WHERE id = ?`,
      ).run(inicio, fim, campos.minutos_por_volta, campos.teto_semanal_min, campos.questoes_mistas_min, campos.anotacao, faseId);
    } else {
      faseId = Number(
        db
          .prepare(
            `INSERT INTO fase (plano_id, nome, inicio, fim, minutos_por_volta, teto_semanal_min, questoes_mistas_min, anotacao)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(planoId, nome, inicio, fim, campos.minutos_por_volta, campos.teto_semanal_min, campos.questoes_mistas_min, campos.anotacao)
          .lastInsertRowid,
      );
    }
    if (dados.materias !== undefined) {
      db.prepare('DELETE FROM fase_materia WHERE fase_id = ?').run(faseId);
      const inserir = db.prepare('INSERT INTO fase_materia (fase_id, materia_id, peso, tipo, fora, grupo_foco) VALUES (?, ?, ?, ?, ?, ?)');
      for (const c of config.values()) inserir.run(faseId, c.materia_id, c.peso, c.tipo, c.fora ? 1 : 0, c.grupo_foco);
    }
    return faseDoCiclo(db, faseId);
  });
}

export function apagarFase(db, planoId, nome) {
  const fase = db.prepare('SELECT * FROM fase WHERE plano_id = ? AND nome = ?').get(planoId, nome);
  if (!fase) throw new Error(`Fase "${nome}" não existe neste plano.`);
  db.prepare('DELETE FROM fase WHERE id = ?').run(fase.id);
  return fase;
}

// Teto da semana: o da fase ativa, senão o do plano.
export function semanaDoPlano(db, planoId, hoje = dataLocal()) {
  const plano = db.prepare('SELECT * FROM plano WHERE id = ?').get(planoId);
  const fase = faseAtiva(db, planoId, hoje);
  return { modo: plano?.modo_semana === 'teto' ? 'teto' : 'meta', teto: fase?.teto_semanal_min ?? plano?.teto_semanal_min ?? null };
}
