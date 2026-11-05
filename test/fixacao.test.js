import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/db.js';
import { importarEdital } from '../src/edital.js';
import * as f from '../src/fixacao.js';

function plano() {
  const db = abrirBanco(':memory:');
  const { planoId } = importarEdital(db, { nomePlano: 'T', markdown: '### Trânsito (10)\n- CTB\n### Ética (5)\n- Deveres' });
  const materias = db.prepare('SELECT id, nome FROM materia ORDER BY posicao').all();
  return { db, planoId, transito: materias[0].id, etica: materias[1].id };
}

const cartoes = (n, prefixo = 'c') => Array.from({ length: n }, (_, i) => ({ frente: `${prefixo} frente ${i + 1}`, verso: `${prefixo} verso ${i + 1}` }));

test('adiciona cartões, lista baralhos com contagem e filtra por matéria', () => {
  const { db, planoId, transito, etica } = plano();
  const ids = f.adicionarFlashcards(db, planoId, { baralho: 'Aula 09', materiaId: transito, materialId: 7, paginaDe: 9, paginaAte: 22, cartoes: cartoes(3) });
  assert.equal(ids.length, 3);
  f.adicionarFlashcards(db, planoId, { baralho: 'Aula 02', materiaId: etica, cartoes: cartoes(2, 'e') });
  const todos = f.listarBaralhos(db, planoId);
  assert.deepEqual(todos.map((b) => [b.baralho, b.cartoes]).sort(), [['Aula 02', 2], ['Aula 09', 3]]);
  const so = f.listarBaralhos(db, planoId, { materiaId: transito });
  assert.equal(so.length, 1);
  assert.deepEqual([so[0].materia, so[0].pagina_de, so[0].pagina_ate, so[0].material_id], ['Trânsito', 9, 22, 7]);
  assert.match(so[0].criado_em, /^\d{4}-\d{2}-\d{2}$/);
});

test('cartão sem frente ou verso desfaz o baralho inteiro', () => {
  const { db, planoId } = plano();
  assert.throws(() => f.adicionarFlashcards(db, planoId, { baralho: 'X', cartoes: [{ frente: 'a', verso: 'b' }, { frente: 'a', verso: ' ' }] }), /Cartão 2 inválido/);
  assert.throws(() => f.adicionarFlashcards(db, planoId, { baralho: ' ', cartoes: cartoes(1) }), /nome/);
  assert.equal(f.listarFlashcards(db, planoId).length, 0);
});

test('embaralhar não perde nem repete cartão, e limite corta', () => {
  const { db, planoId } = plano();
  f.adicionarFlashcards(db, planoId, { baralho: 'B', cartoes: cartoes(25) });
  const normal = f.listarFlashcards(db, planoId, { baralho: 'B' });
  const mix = f.listarFlashcards(db, planoId, { baralho: 'B', aleatorio: true });
  assert.equal(mix.length, 25);
  assert.deepEqual(mix.map((c) => c.id).sort((a, b) => a - b), normal.map((c) => c.id));
  assert.equal(f.listarFlashcards(db, planoId, { baralho: 'B', limite: 5 }).length, 5);
});

test('marcar visto conta e guarda a data', () => {
  const { db, planoId } = plano();
  const [id] = f.adicionarFlashcards(db, planoId, { baralho: 'B', cartoes: cartoes(1) });
  assert.equal(f.listarFlashcards(db, planoId)[0].vezes_visto, 0);
  f.marcarVisto(db, id);
  f.marcarVisto(db, id);
  const c = f.listarFlashcards(db, planoId)[0];
  assert.equal(c.vezes_visto, 2);
  assert.ok(c.visto_em);
});

test('apaga cartão por id e baralho inteiro', () => {
  const { db, planoId } = plano();
  const ids = f.adicionarFlashcards(db, planoId, { baralho: 'A', cartoes: cartoes(3) });
  f.adicionarFlashcards(db, planoId, { baralho: 'B', cartoes: cartoes(2) });
  assert.equal(f.apagarFlashcard(db, ids[0]), 1);
  assert.equal(f.listarFlashcards(db, planoId, { baralho: 'A' }).length, 2);
  assert.equal(f.apagarBaralho(db, planoId, 'A'), 2);
  assert.deepEqual(f.listarBaralhos(db, planoId).map((b) => b.baralho), ['B']);
});

const ARVORE = {
  texto: 'Crimes de trânsito',
  filhos: [
    { texto: 'Homicídio culposo', nota: 'Art. 302', filhos: [{ texto: 'Pena de 2 a 4 anos' }] },
    { texto: 'Embriaguez ao volante' },
  ],
};

test('salva e lê mapa, lista sem a árvore, substitui por id e apaga', () => {
  const { db, planoId, transito } = plano();
  const id = f.salvarMapa(db, planoId, { titulo: 'Trânsito', materiaId: transito, paginaDe: 9, paginaAte: 22, arvore: ARVORE });
  const lista = f.listarMapas(db, planoId);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].arvore, undefined);
  assert.equal(lista[0].materia, 'Trânsito');
  const mapa = f.lerMapa(db, id);
  assert.equal(mapa.arvore.filhos[0].nota, 'Art. 302');
  assert.deepEqual(mapa.arvore.filhos[1].filhos, []);

  const mesmo = f.salvarMapa(db, planoId, { id, titulo: 'Trânsito v2', arvore: { texto: 'Nova raiz' } });
  assert.equal(mesmo, id);
  assert.equal(f.listarMapas(db, planoId).length, 1);
  assert.equal(f.lerMapa(db, id).titulo, 'Trânsito v2');
  assert.equal(f.lerMapa(db, id).arvore.texto, 'Nova raiz');
  assert.throws(() => f.salvarMapa(db, planoId, { id: 999, titulo: 'x', arvore: ARVORE }), /não existe/);

  assert.equal(f.apagarMapa(db, id), 1);
  assert.throws(() => f.lerMapa(db, id), /não existe/);
});

test('árvore inválida é recusada: raiz vazia, 7 níveis, 301 nós, textos longos', () => {
  const { db, planoId } = plano();
  const salvar = (arvore) => f.salvarMapa(db, planoId, { titulo: 'x', arvore });
  assert.throws(() => salvar({ texto: '  ' }), /raiz/);
  const aninhada = (niveis) => {
    let no = { texto: `n${niveis}` };
    for (let i = niveis - 1; i >= 1; i--) no = { texto: `n${i}`, filhos: [no] };
    return no;
  };
  assert.doesNotThrow(() => salvar(aninhada(6)));
  assert.throws(() => salvar(aninhada(7)), /6 níveis/);
  const larga = (n) => ({ texto: 'r', filhos: Array.from({ length: n - 1 }, (_, i) => ({ texto: `f${i}` })) });
  assert.doesNotThrow(() => salvar(larga(300)));
  assert.throws(() => salvar(larga(301)), /300 nós/);
  assert.throws(() => salvar({ texto: 'a'.repeat(201) }), /200/);
  assert.throws(() => salvar({ texto: 'a', nota: 'b'.repeat(501) }), /500/);
  assert.throws(() => salvar({ texto: 'a', filhos: [{ texto: '' }] }), /sem texto/);
  assert.throws(() => f.salvarMapa(db, planoId, { titulo: '', arvore: ARVORE }), /título/);
});

test('mapas e baralhos somem com o plano, e filtro de mapa por matéria funciona', () => {
  const { db, planoId, transito, etica } = plano();
  f.salvarMapa(db, planoId, { titulo: 'A', materiaId: transito, arvore: ARVORE });
  f.salvarMapa(db, planoId, { titulo: 'B', materiaId: etica, arvore: ARVORE });
  assert.deepEqual(f.listarMapas(db, planoId, { materiaId: etica }).map((m) => m.titulo), ['B']);
  f.adicionarFlashcards(db, planoId, { baralho: 'A', cartoes: cartoes(1) });
  db.prepare('DELETE FROM plano WHERE id = ?').run(planoId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mapa_mental').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM flashcard').get().n, 0);
});
