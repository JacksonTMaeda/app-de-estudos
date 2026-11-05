import { test } from 'node:test';
import assert from 'node:assert/strict';
import { novoRelogio, pausar, continuar, msCorridos } from '../ui/pausa.js';

test('sem pausa, conta o tempo inteiro', () => {
  const r = novoRelogio(1000);
  assert.equal(msCorridos(r, 61000), 60000);
});

test('o tempo pausado não entra na conta', () => {
  const r = novoRelogio(0);
  pausar(r, 30000);
  continuar(r, 330000); // 5 min pausado
  assert.equal(msCorridos(r, 360000), 60000);
});

test('pausado, o relógio fica parado', () => {
  const r = novoRelogio(0);
  pausar(r, 45000);
  assert.equal(msCorridos(r, 45000), 45000);
  assert.equal(msCorridos(r, 900000), 45000);
});

test('várias pausas somam', () => {
  const r = novoRelogio(0);
  pausar(r, 10000);
  continuar(r, 20000);
  pausar(r, 30000);
  continuar(r, 50000);
  assert.equal(msCorridos(r, 60000), 30000);
});

test('pausar duas vezes não reinicia a pausa, continuar sem pausa não faz nada', () => {
  const r = novoRelogio(0);
  pausar(r, 10000);
  pausar(r, 20000);
  continuar(r, 30000);
  continuar(r, 40000);
  assert.equal(msCorridos(r, 50000), 30000);
});

test('relógio vazio vale zero', () => {
  assert.equal(msCorridos(null), 0);
  assert.equal(msCorridos({}), 0);
});
