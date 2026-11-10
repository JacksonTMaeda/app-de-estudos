import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conferirArgumentos } from '../src/esquema.js';

const ESQUEMA = {
  type: 'object',
  properties: {
    plano_id: { type: 'integer' },
    tipo: { type: 'string', enum: ['teoria', 'questoes', 'revisao'] },
    quando: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Dia (YYYY-MM-DD)' },
    minutos: { type: 'integer', minimum: 0, maximum: 600 },
    peso: { type: 'number', exclusiveMinimum: 0 },
    nota: { type: 'string', maxLength: 5 },
    confirma: { type: 'boolean' },
    questoes: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: { enunciado: { type: 'string' }, correta: { type: ['integer', 'string'] }, alternativas: { type: 'array', items: { type: 'string' }, minItems: 2 } },
        required: ['enunciado', 'correta'],
      },
    },
  },
  required: ['tipo'],
};

test('argumentos dentro do esquema passam, e o que o esquema não cita não é conferido', () => {
  assert.deepEqual(conferirArgumentos(ESQUEMA, { tipo: 'teoria' }), []);
  assert.deepEqual(
    conferirArgumentos(ESQUEMA, {
      plano_id: 2, tipo: 'questoes', quando: '2026-11-09', minutos: 0, peso: 0.5, nota: 'curta', confirma: false, extra: { livre: 1 },
      questoes: [{ enunciado: 'x', correta: 'B', alternativas: ['a', 'b'] }, { enunciado: 'y', correta: 0 }],
    }),
    [],
  );
});

test('opcional que vem null conta como não enviado; obrigatório null ou ausente é recusado', () => {
  assert.deepEqual(conferirArgumentos(ESQUEMA, { tipo: 'teoria', plano_id: null, quando: null }), []);
  assert.deepEqual(conferirArgumentos(ESQUEMA, {}), ['tipo: é obrigatório']);
  assert.deepEqual(conferirArgumentos(ESQUEMA, { tipo: null }), ['tipo: é obrigatório']);
});

test('cada regra do esquema é cobrada, com o caminho do argumento na mensagem', () => {
  const um = (args) => {
    const erros = conferirArgumentos(ESQUEMA, { tipo: 'teoria', ...args });
    assert.equal(erros.length, 1, JSON.stringify(erros));
    return erros[0];
  };
  assert.match(um({ plano_id: '2' }), /^plano_id: esperava número inteiro, veio "2"/);
  assert.match(um({ plano_id: 2.5 }), /^plano_id: esperava número inteiro/);
  assert.match(um({ tipo: 'outro' }), /^tipo: precisa ser um de teoria, questoes, revisao/);
  assert.match(um({ quando: '09-11-2026' }), /^quando: formato inválido, veio "09-11-2026" \(Dia \(YYYY-MM-DD\)\)/);
  assert.match(um({ minutos: -1 }), /^minutos: mínimo 0, veio -1/);
  assert.match(um({ minutos: 601 }), /^minutos: máximo 600/);
  assert.match(um({ peso: 0 }), /^peso: precisa ser maior que 0/);
  assert.match(um({ peso: Number.NaN }), /^peso: esperava número/);
  assert.match(um({ nota: 'comprida' }), /^nota: no máximo 5 caracteres/);
  assert.match(um({ confirma: 'sim' }), /^confirma: esperava verdadeiro ou falso/);
  assert.match(um({ questoes: [] }), /^questoes: precisa de pelo menos 1 item/);
  assert.match(um({ questoes: 'abc' }), /^questoes: esperava lista/);
  assert.match(um({ questoes: [1, 2, 3, 4].map(() => ({ enunciado: 'x', correta: 0 })) }), /^questoes: no máximo 3 itens/);
  assert.match(um({ questoes: [{ enunciado: 'x', correta: 0 }, { enunciado: 'y' }] }), /^questoes\[2\]\.correta: é obrigatório/);
  assert.match(um({ questoes: [{ enunciado: 'x', correta: true }] }), /^questoes\[1\]\.correta: esperava número inteiro ou texto, veio true/);
  assert.match(um({ questoes: [{ enunciado: 'x', correta: 0, alternativas: ['a'] }] }), /^questoes\[1\]\.alternativas: precisa de pelo menos 2 itens/);
});

test('argumentos que não são objeto são recusados inteiros', () => {
  assert.match(conferirArgumentos(ESQUEMA, [1, 2])[0], /^argumentos: esperava objeto/);
  assert.match(conferirArgumentos(ESQUEMA, 'texto')[0], /^argumentos: esperava objeto/);
});
