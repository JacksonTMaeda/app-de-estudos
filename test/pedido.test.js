import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codificarPedido, lerPedido, MAX_IDS } from '../src/pedido.js';

test('pedido do Claude vai e volta pela linha de comando, e o que foge do formato é ignorado', () => {
  const pedido = { tipo: 'questoes', planoId: 2, ids: [318, 331, 318] };
  assert.deepEqual(lerPedido(['App De Estudos.exe', '--flag', codificarPedido(pedido)]), { tipo: 'questoes', planoId: 2, ids: [318, 331] });
  assert.equal(lerPedido(['App De Estudos.exe']), null);
  assert.equal(lerPedido(['--pedido=nao-e-json']), null);
  for (const ruim of [
    { tipo: 'apagar', planoId: 2, ids: [1] },
    { tipo: 'questoes', planoId: '2', ids: [1] },
    { tipo: 'questoes', planoId: 2, ids: [] },
    { tipo: 'questoes', planoId: 2, ids: [1.5] },
    { tipo: 'questoes', planoId: 2, ids: Array.from({ length: MAX_IDS + 1 }, (_, i) => i + 1) },
  ]) assert.equal(lerPedido([codificarPedido(ruim)]), null, JSON.stringify(ruim).slice(0, 60));
});
