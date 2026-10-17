import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abrirBanco } from '../src/db.js';
import { importarEdital } from '../src/edital.js';
import * as q from '../src/questoes.js';

const QUIZ_NOVO = `<html><script>
  // comentário com ] e [ que não pode confundir o leitor
  var LIXO = 1;
  var Q = [
    {n:1, fonte:"FGV / PC-MG / 2025", tema:"Redes", en:"<p>Qual camada? [x]</p>", alts:["Física","Enlace","Rede"], c:1, com:"Switch é \\"enlace\\"."},
    {n:2, fonte:"AUTORAL (nenhuma questão real)", tema:"Redes", en:"Pergunta 2", alts:["a","b"], c:0, com:"ok"}
  ];
</script></html>`;

const QUIZ_ANTIGO = `<script>
  const QUESTIONS = [
    { n: 1, topic: "Célula", stem: "Teoria celular?", opts: ["x", "y", "z"], correct: 2, exp: "porque z" },
    { n: 2, topic: "Sem gabarito", stem: "inválida", opts: ["x", "y"] }
  ];
</script>`;

test('extrai o array mesmo com colchetes em strings e comentários', () => {
  const texto = q.extrairArray(QUIZ_NOVO);
  assert.ok(texto.startsWith('[') && texto.endsWith(']'));
  assert.equal(q.lerQuiz(QUIZ_NOVO).length, 2);
});

test('normaliza os dois formatos de quiz e descarta questão sem gabarito', () => {
  const [nova] = q.lerQuiz(QUIZ_NOVO);
  assert.deepEqual(
    { fonte: nova.fonte, tema: nova.tema, correta: nova.correta, n: nova.alternativas.length },
    { fonte: 'FGV / PC-MG / 2025', tema: 'Redes', correta: 1, n: 3 },
  );
  const antigas = q.lerQuiz(QUIZ_ANTIGO);
  assert.equal(antigas.length, 1);
  assert.equal(antigas[0].correta, 2);
  assert.equal(antigas[0].comentario, 'porque z');
});

test('gabarito em letra também vale', () => {
  assert.equal(q.normalizar({ q: 'x', options: ['a', 'b', 'c'], answer: 'C' }, 0).correta, 2);
});

test('código do quiz não acessa nada fora da caixa', () => {
  const malicioso = '<script>var Q = [{en:"x", alts:["a","b"], c: (typeof process === "undefined" ? 0 : 1)}];</script>';
  assert.equal(q.lerQuiz(malicioso)[0].correta, 0);
});

test('pasta casa com a matéria pelas palavras', () => {
  const materias = [{ id: 1, nome: 'Tecnologia, Segurança Cibernética e Crimes Digitais' }, { id: 2, nome: 'Língua Portuguesa' }];
  assert.equal(q.materiaDaPasta('Tecnologia e Crimes Digitais', materias).id, 1);
  assert.equal(q.materiaDaPasta('Lingua Portuguesa', materias).id, 2);
  assert.equal(q.materiaDaPasta('Recurso', materias), null);
});

function planoComQuizzes() {
  const db = abrirBanco(':memory:');
  const { planoId } = importarEdital(db, {
    nomePlano: 'T',
    markdown: '### Tecnologia e Crimes Digitais (10)\n- Redes\n### Biologia (5)\n- Célula',
  });
  const pasta = mkdtempSync(join(tmpdir(), 'quiz-'));
  mkdirSync(join(pasta, 'Tecnologia e Crimes Digitais', 'Quiz'), { recursive: true });
  mkdirSync(join(pasta, 'Biologia'));
  writeFileSync(join(pasta, 'Tecnologia e Crimes Digitais', 'Quiz', 'redes.html'), QUIZ_NOVO);
  writeFileSync(join(pasta, 'Biologia', 'cito.html'), QUIZ_ANTIGO);
  writeFileSync(join(pasta, 'Biologia', 'nao-quiz.html'), '<p>sem questões</p>');
  return { db, planoId, pasta };
}

test('importa a pasta, liga à matéria e não duplica ao reimportar', () => {
  const { db, planoId, pasta } = planoComQuizzes();
  const relatorio = q.importarPasta(db, planoId, pasta);
  assert.equal(relatorio.length, 2);
  q.importarPasta(db, planoId, pasta);
  const todas = q.listarQuestoes(db, planoId);
  assert.equal(todas.length, 3);
  assert.deepEqual([...new Set(todas.map((x) => x.materia))].sort(), ['Biologia', 'Tecnologia e Crimes Digitais']);
});

test('filtra por banca, autoral e banca específica', () => {
  const { db, planoId, pasta } = planoComQuizzes();
  q.importarPasta(db, planoId, pasta);
  assert.equal(q.listarQuestoes(db, planoId, { origem: 'banca' }).length, 1);
  assert.equal(q.listarQuestoes(db, planoId, { origem: 'autoral' }).length, 2);
  assert.equal(q.listarQuestoes(db, planoId, { origem: 'FGV' }).length, 1);
  assert.equal(q.listarQuestoes(db, planoId, { origem: 'CEBRASPE' }).length, 0);
  assert.deepEqual(q.listarBancas(db, planoId), [{ banca: 'FGV', total: 1 }]);
});

test('responder grava e muda a situação da questão', () => {
  const { db, planoId, pasta } = planoComQuizzes();
  q.importarPasta(db, planoId, pasta);
  const [fgv] = q.listarQuestoes(db, planoId, { origem: 'FGV' });
  const { acertou, correta } = q.responderQuestao(db, fgv.id, 0);
  assert.deepEqual({ acertou, correta }, { acertou: false, correta: 1 });
  assert.equal(q.listarQuestoes(db, planoId, { situacao: 'erradas' }).length, 1);
  assert.equal(q.listarQuestoes(db, planoId, { situacao: 'nao_respondidas' }).length, 2);
  q.responderQuestao(db, fgv.id, 1);
  assert.equal(q.listarQuestoes(db, planoId, { situacao: 'erradas' }).length, 0);
  const tec = q.resumoQuestoes(db, planoId).find((r) => r.materia.startsWith('Tecnologia'));
  assert.deepEqual({ total: tec.total, respondidas: tec.respondidas, acertos: tec.acertos, respostas: tec.respostas },
    { total: 2, respondidas: 1, acertos: 1, respostas: 2 });
});

// Pasta real de quizzes, fora do repositório. Caminho em ESTUDOS_QUIZZES_REAIS; sem a variável, o teste é pulado.
const COFRE = process.env.ESTUDOS_QUIZZES_REAIS;
test('importa uma pasta real de quizzes', { skip: !COFRE || !existsSync(COFRE) }, () => {
  const db = abrirBanco(':memory:');
  const { planoId } = importarEdital(db, {
    nomePlano: 'PCPR',
    markdown: require_edital(),
  });
  const relatorio = q.importarPasta(db, planoId, COFRE);
  const total = relatorio.reduce((a, r) => a + r.questoes, 0);
  assert.ok(total >= 300, `só ${total}`);
  assert.ok(relatorio.every((r) => r.materia), JSON.stringify(relatorio.filter((r) => !r.materia)));
});

function require_edital() {
  return ['Língua Portuguesa (25)', 'Raciocínio Lógico-Matemático (5)', 'Tecnologia, Segurança Cibernética e Crimes Digitais (15)',
    'Ciências Forenses (10)', 'Biologia (10)'].map((m) => `### ${m}\n- tópico`).join('\n');
}
