import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../src/db.js';
import { importarEdital } from '../src/edital.js';
import * as q from '../src/questoes.js';
import { analisarQuestoes } from '../src/analise.js';

function planoComQuestoes() {
  const db = abrirBanco(':memory:');
  const { planoId } = importarEdital(db, { nomePlano: 'T', markdown: '### Português (20)\n- a\n### Lógica (10)\n- b' });
  q.prepararQuestoes(db);
  const inserir = db.prepare(
    `INSERT INTO questao (plano_id, materia_id, origem, numero, fonte, tema, enunciado, alternativas, correta)
     VALUES (?, ?, 'x.html', ?, ?, ?, 'e', '["a","b","c"]', 0)`,
  );
  const [port, logica] = db.prepare('SELECT id FROM materia ORDER BY posicao').all().map((m) => m.id);
  inserir.run(planoId, port, 1, 'FGV / PC-MG / 2025', 'Crase');
  inserir.run(planoId, port, 2, 'FGV / TJ / 2024', 'Crase');
  inserir.run(planoId, port, 3, 'CEBRASPE / PF / 2021', 'Verbos');
  inserir.run(planoId, logica, 4, 'AUTORAL', 'Conjuntos');
  const ids = db.prepare('SELECT id FROM questao ORDER BY numero').all().map((x) => x.id);
  return { db, planoId, ids };
}

test('resposta guarda o tempo e só a errada aceita causa', () => {
  const { db, ids } = planoComQuestoes();
  const certa = q.responderQuestao(db, ids[0], 0, 42.4);
  const errada = q.responderQuestao(db, ids[1], 2, 75);
  q.marcarCausa(db, certa.respostaId, 'chute');
  q.marcarCausa(db, errada.respostaId, 'leitura');
  const linhas = db.prepare('SELECT segundos, causa FROM resposta ORDER BY id').all();
  assert.deepEqual(linhas.map((l) => ({ ...l })), [{ segundos: 42, causa: null }, { segundos: 75, causa: 'leitura' }]);
  assert.throws(() => q.marcarCausa(db, errada.respostaId, 'azar'), /Causa desconhecida/);
  q.marcarCausa(db, errada.respostaId, null);
  assert.equal(db.prepare('SELECT causa FROM resposta WHERE id = ?').get(errada.respostaId).causa, null);
});

test('banco antigo ganha as colunas novas sem perder respostas', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE plano (id INTEGER PRIMARY KEY, nome TEXT);
           CREATE TABLE materia (id INTEGER PRIMARY KEY);
           CREATE TABLE resposta (id INTEGER PRIMARY KEY, questao_id INTEGER, escolhida INTEGER, acertou INTEGER, respondida_em TEXT);
           INSERT INTO resposta VALUES (1, 1, 0, 1, '2026-10-17 10:00:00');`);
  q.prepararQuestoes(db);
  const colunas = db.prepare('PRAGMA table_info(resposta)').all().map((c) => c.name);
  assert.ok(colunas.includes('segundos') && colunas.includes('causa'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM resposta').get().n, 1);
});

test('análise agrega por matéria, banca, tema, causa e semana', () => {
  const { db, planoId, ids } = planoComQuestoes();
  q.responderQuestao(db, ids[0], 0, 60);
  q.marcarCausa(db, q.responderQuestao(db, ids[1], 1, 120).respostaId, 'conceito');
  q.marcarCausa(db, q.responderQuestao(db, ids[1], 2, 90).respostaId, 'conceito');
  q.responderQuestao(db, ids[2], 0, 30);
  q.marcarCausa(db, q.responderQuestao(db, ids[3], 1, 45).respostaId, 'leitura');

  const a = analisarQuestoes(db, planoId);
  assert.equal(a.geral.respostas, 5);
  assert.equal(a.geral.acertos, 2);
  assert.equal(a.geral.questoes, 4);
  assert.equal(a.geral.banco, 4);
  assert.equal(a.geral.segundos_medio, 69);

  const porMateria = Object.fromEntries(a.porMateria.map((m) => [m.nome, [m.acertos, m.respostas]]));
  assert.deepEqual(porMateria, { Português: [2, 4], Lógica: [0, 1] });
  const porBanca = Object.fromEntries(a.porBanca.map((b) => [b.nome, [b.acertos, b.respostas]]));
  // CEBRASPE tem 1 resposta só: entra em "Outras bancas".
  assert.deepEqual(porBanca, { FGV: [1, 3], Autoral: [0, 1], 'Outras bancas (1)': [1, 1] });

  assert.deepEqual(a.pioresTemas.map((t) => [t.materia, t.nome]), [['Português', 'Crase']]); // único com 2 ou mais e erro
  assert.deepEqual(Object.fromEntries(a.causas.lista.map((c) => [c.chave, c.total])),
    { conceito: 2, decoreba: 0, leitura: 1, tempo: 0, chute: 0 });
  assert.equal(a.causas.semCausa, 0);

  assert.deepEqual(a.paraRefazer.map((x) => [x.id, x.erros]), [[ids[1], 2], [ids[3], 1]]);
  assert.equal(a.porSemana.length, 1);
  assert.equal(a.porSemana[0].respostas, 5);
});

test('acertar depois tira a questão da lista para refazer', () => {
  const { db, planoId, ids } = planoComQuestoes();
  q.responderQuestao(db, ids[0], 1);
  assert.equal(analisarQuestoes(db, planoId).paraRefazer.length, 1);
  q.responderQuestao(db, ids[0], 0);
  assert.equal(analisarQuestoes(db, planoId).paraRefazer.length, 0);
});

test('listar por ids devolve só essas questões', () => {
  const { db, planoId, ids } = planoComQuestoes();
  assert.deepEqual(q.listarQuestoes(db, planoId, { ids: [ids[2], ids[0]] }).map((x) => x.id).sort(), [ids[0], ids[2]].sort());
  assert.equal(q.listarQuestoes(db, planoId, { ids: [] }).length, 0);
});
