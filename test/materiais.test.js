import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { abrirBanco } from '../src/db.js';
import { importarEdital } from '../src/edital.js';
import * as mt from '../src/materiais.js';

const EDITAL = `
### Língua Portuguesa (20)
- [ ] Crase
### Raciocínio Lógico-Matemático (10)
- [ ] Conjuntos
### Direito Penal Aplicado (10)
- [ ] Crimes
### Direito Processual Penal Aplicado (10)
- [ ] Inquérito
### Tecnologia, Segurança Cibernética e Crimes Digitais (5)
- [ ] Redes
`;

function preparar() {
  const db = abrirBanco(':memory:');
  mt.prepararMateriais(db);
  const { planoId } = importarEdital(db, { nomePlano: 'Teste', markdown: EDITAL });
  const raiz = mkdtempSync(join(tmpdir(), 'materiais-'));
  const pdf = (...partes) => {
    mkdirSync(join(raiz, ...partes.slice(0, -1)), { recursive: true });
    writeFileSync(join(raiz, ...partes), '%PDF-1.4 teste');
  };
  return { db, planoId, raiz, pdf, limpar: () => rmSync(raiz, { recursive: true, force: true }) };
}

test('nome da pasta acha a matéria mesmo escrito diferente', () => {
  const { db, planoId, limpar } = preparar();
  const materias = db.prepare('SELECT id, nome FROM materia WHERE plano_id = ?').all(planoId);
  const id = (nome) => materias.find((m) => m.nome === nome).id;
  assert.equal(mt.materiaDaPasta('Portugues', materias), id('Língua Portuguesa'));
  assert.equal(mt.materiaDaPasta('Raciocínio Lógico e Matemático', materias), id('Raciocínio Lógico-Matemático'));
  assert.equal(mt.materiaDaPasta('Direito Penal Aplicado', materias), id('Direito Penal Aplicado'));
  assert.equal(mt.materiaDaPasta('Direito Processual Penal', materias), id('Direito Processual Penal Aplicado'));
  assert.equal(mt.materiaDaPasta('Tecnologia e Crimes Digitais', materias), id('Tecnologia, Segurança Cibernética e Crimes Digitais'));
  assert.equal(mt.materiaDaPasta('_Bizu Estratégico', materias), null);
  limpar();
});

test('escanear lista os PDFs, guarda a página e mantém o que já estava', () => {
  const { db, planoId, raiz, pdf, limpar } = preparar();
  pdf('Portugues', 'Aula 01.pdf');
  pdf('Portugues', 'Extras', 'Resumo.pdf');
  pdf('_Bizu', 'Bizu.pdf');
  pdf('Portugues', 'anotacao.txt');
  const r = mt.escanearPasta(db, planoId, raiz);
  assert.deepEqual([r.total, r.novos, r.sumiram], [3, 3, 0]);
  const lista = mt.listarMateriais(db, planoId);
  const aula = lista.find((m) => m.nome === 'Aula 01');
  assert.equal(aula.materia, 'Língua Portuguesa');
  assert.equal(lista.find((m) => m.nome === 'Resumo').pasta, 'Portugues / Extras');
  assert.equal(lista.find((m) => m.nome === 'Bizu').materia_id, null);

  mt.guardarPagina(db, aula.id, 12, 40);
  mt.associarMateria(db, lista.find((m) => m.nome === 'Bizu').id, aula.materia_id);
  rmSync(join(raiz, 'Portugues', 'Extras'), { recursive: true });
  const r2 = mt.escanearPasta(db, planoId, raiz);
  assert.deepEqual([r2.total, r2.novos, r2.sumiram], [2, 0, 1]);
  const depois = mt.listarMateriais(db, planoId);
  assert.equal(depois.find((m) => m.nome === 'Aula 01').ultima_pagina, 12);
  assert.equal(depois.find((m) => m.nome === 'Aula 01').paginas, 40);
  assert.equal(depois.find((m) => m.nome === 'Bizu').materia, 'Língua Portuguesa');
  limpar();
});

test('página fica dentro do total', () => {
  const { db, planoId, raiz, pdf, limpar } = preparar();
  pdf('Portugues', 'Aula.pdf');
  mt.escanearPasta(db, planoId, raiz);
  const [m] = mt.listarMateriais(db, planoId);
  mt.guardarPagina(db, m.id, 99, 30);
  assert.equal(mt.obterMaterial(db, m.id).ultima_pagina, 30);
  mt.guardarPagina(db, m.id, -3);
  assert.equal(mt.obterMaterial(db, m.id).ultima_pagina, 1);
  limpar();
});

test('só lê PDF de dentro da pasta do plano', () => {
  const { db, planoId, raiz, pdf, limpar } = preparar();
  pdf('Portugues', 'Aula.pdf');
  mt.escanearPasta(db, planoId, raiz);
  const [m] = mt.listarMateriais(db, planoId);
  assert.equal(mt.lerPdf(db, m.id).toString(), '%PDF-1.4 teste');
  db.prepare('UPDATE material SET caminho = ? WHERE id = ?').run(join(raiz, '..', 'fora.pdf'), m.id);
  assert.throws(() => mt.lerPdf(db, m.id), /fora da pasta/);
  db.prepare('UPDATE material SET caminho = ? WHERE id = ?').run(join(raiz, 'Portugues', 'segredo.txt'), m.id);
  assert.throws(() => mt.lerPdf(db, m.id), /fora da pasta/);
  limpar();
});

test('subpasta que não deu para ler não tira os PDFs dela da lista', () => {
  const { db, planoId, raiz, pdf, limpar } = preparar();
  pdf('Portugues', 'Aula.pdf');
  pdf('Logica', 'Aula.pdf');
  mt.escanearPasta(db, planoId, raiz);
  mt.guardarPagina(db, mt.listarMateriais(db, planoId).find((m) => m.pasta === 'Logica').id, 7, 20);
  // Simula a pasta Logica sem permissão de leitura.
  const semLogica = (r) => {
    const achado = mt.acharPdfs(r);
    return { pdfs: achado.pdfs.filter((c) => !c.includes(`${join(r, 'Logica')}`)), ilegiveis: [join(r, 'Logica')] };
  };
  const r = mt.escanearPasta(db, planoId, raiz, semLogica);
  assert.equal(r.sumiram, 0);
  assert.equal(r.pastas_ilegiveis.length, 1);
  assert.equal(mt.listarMateriais(db, planoId).find((m) => m.pasta === 'Logica').ultima_pagina, 7);
  limpar();
});

test('PDF com nome começando por dois pontos abre normalmente', () => {
  const { db, planoId, raiz, pdf, limpar } = preparar();
  pdf('..resumo.pdf');
  mt.escanearPasta(db, planoId, raiz);
  const [m] = mt.listarMateriais(db, planoId);
  assert.equal(mt.lerPdf(db, m.id).toString(), '%PDF-1.4 teste');
  limpar();
});
