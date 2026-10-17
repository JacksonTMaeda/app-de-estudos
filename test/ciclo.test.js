import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularPesos, montarBlocos, quebrarEmBlocos, pesoBruto, gerarCiclo, repartir } from '../src/ciclo.js';
import { abrirBanco } from '../src/db.js';

const materia = (nome, conhecimento = 2.5, importancia = 2.5) => ({ nome, conhecimento, importancia });

test('peso bruto segue a fórmula do Estudei', () => {
  assert.equal(pesoBruto(materia('x', 0, 3)), 3);
  assert.equal(pesoBruto(materia('x', 1, 3)), 1.5);
  assert.ok(Math.abs(pesoBruto(materia('x', 0.5, 2.5)) - 1.7678) < 1e-4);
});

test('cinco matérias iguais dão 20% cada', () => {
  const pesos = calcularPesos(['A', 'B', 'C', 'D', 'E'].map((n) => materia(n)));
  assert.deepEqual(pesos.map((p) => p.peso), [20, 20, 20, 20, 20]);
});

test('não conhecer ganha 16 vezes o tempo de dominar', () => {
  const [fraca, forte] = calcularPesos([materia('Fraca', 0.5), materia('Forte', 4.5)]);
  assert.ok(Math.abs(fraca.fracao / forte.fracao - 16) < 1e-9);
});

test('168 min viram um bloco de 75 e um de 90', () => {
  assert.deepEqual(quebrarEmBlocos(168, { min: 45, max: 90, passo: 15 }), [75, 90]);
});

test('matéria com pouco tempo ainda ganha um bloco mínimo', () => {
  assert.deepEqual(quebrarEmBlocos(10, { min: 45, max: 90, passo: 15 }), [45]);
});

// Ciclo real capturado do Estudei: 840 min, 45/90/15,
// cinco matérias em 2,5/2,5. Posições 1 a 10, nesta ordem e com estas durações.
test('reproduz o ciclo do Estudei', () => {
  const materias = [
    'Direito Constitucional', 'Direito Administrativo', 'Língua Portuguesa',
    'Direitos Humanos', 'Raciocínio Lógico-matemático',
  ].map((n) => materia(n));
  const blocos = montarBlocos(materias, { total: 840, min: 45, max: 90, passo: 15 });
  assert.deepEqual(
    blocos.map((b) => [b.materia.nome, b.duracao]),
    [
      ['Direito Administrativo', 75], ['Direito Constitucional', 75], ['Direitos Humanos', 75],
      ['Língua Portuguesa', 75], ['Raciocínio Lógico-matemático', 75],
      ['Direito Administrativo', 90], ['Direito Constitucional', 90], ['Direitos Humanos', 90],
      ['Língua Portuguesa', 90], ['Raciocínio Lógico-matemático', 90],
    ],
  );
});

test('sem matéria pequena, o ciclo tem uma volta só', () => {
  const blocos = montarBlocos(['A', 'B', 'C'].map((n) => materia(n)));
  assert.ok(blocos.every((b) => b.volta === 1));
});

// Mesmas importâncias do edital da PCPR (questões por matéria, somando 100).
const PCPR = [25, 15, 10, 10, 5, 5, 5, 5, 5, 3, 3, 3, 3, 3].map((q, i) => materia(`M${String(i).padStart(2, '0')}`, 2.5, q));

test('matéria pequena entra em volta sim, volta não', () => {
  const blocos = montarBlocos(PCPR);
  const voltasDe = (nome) => new Set(blocos.filter((b) => b.materia.nome === nome).map((b) => b.volta));
  for (const grande of ['M00', 'M01', 'M02', 'M03']) assert.deepEqual([...voltasDe(grande)].sort(), [1, 2], grande);
  for (let i = 4; i < 14; i++) assert.equal(voltasDe(`M${String(i).padStart(2, '0')}`).size, 1);
});

test('cada volta cabe nas 14h', () => {
  const blocos = montarBlocos(PCPR);
  for (const v of [1, 2]) {
    const soma = blocos.filter((b) => b.volta === v).reduce((a, b) => a + b.duracao, 0);
    assert.ok(soma <= 840 && soma >= 840 - 30, `volta ${v}: ${soma} min`);
  }
});

test('número ímpar de matérias pequenas e volta curta não estouram o tempo', () => {
  const casos = [
    [[materia('A', 2.5, 20), materia('B', 2.5, 10)], 120],
    [PCPR.slice(0, 9), 840],
    [PCPR, 600],
    [[materia('A', 2.5, 50), materia('B'), materia('C'), materia('D')], 300],
  ];
  for (const [materias, total] of casos) {
    const blocos = montarBlocos(materias, { total, min: 45, max: 90, passo: 15 });
    for (const v of new Set(blocos.map((b) => b.volta))) {
      const soma = blocos.filter((b) => b.volta === v).reduce((a, b) => a + b.duracao, 0);
      assert.ok(soma <= total, `${materias.length} matérias, ${total} min: volta ${v} deu ${soma}`);
    }
  }
});

test('repartir não passa do total e segue a proporção', () => {
  assert.deepEqual(repartir(41, [25, 15, 10, 10]), [17, 10, 7, 7]);
  assert.deepEqual(repartir(5, [1, 1, 1]).reduce((a, b) => a + b), 5);
});

test('blocos respeitam mínimo, máximo e passo', () => {
  for (const b of montarBlocos(PCPR)) {
    assert.ok(b.duracao >= 45 && b.duracao <= 90 && b.duracao % 15 === 0, `${b.materia.nome}: ${b.duracao}`);
  }
});

test('matérias demais para o tempo dão erro claro', () => {
  const muitas = Array.from({ length: 40 }, (_, i) => materia(`X${i}`));
  assert.throws(() => montarBlocos(muitas, { total: 300, min: 45, max: 90, passo: 15 }), /Matérias demais/);
});

test('matéria mais pesada vem primeiro na rodada', () => {
  const blocos = montarBlocos([materia('Forte', 4.5), materia('Fraca', 0.5)]);
  assert.equal(blocos[0].materia.nome, 'Fraca');
});

test('gerarCiclo grava e substitui o ciclo do plano', () => {
  const db = abrirBanco(':memory:');
  const { lastInsertRowid: planoId } = db.prepare("INSERT INTO plano (nome) VALUES ('P')").run();
  db.prepare("INSERT INTO materia (plano_id, nome, posicao) VALUES (?, 'A', 1), (?, 'B', 2)").run(planoId, planoId);
  gerarCiclo(db, planoId);
  gerarCiclo(db, planoId, { total: 600 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ciclo').get().n, 1);
  const soma = db.prepare('SELECT SUM(duracao_min) s FROM bloco').get().s;
  assert.equal(soma, 600);
});
