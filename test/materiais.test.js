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

test('grifo, sublinhado e nota ficam no banco e o PDF não muda', () => {
  const { db, planoId, raiz, pdf, limpar } = preparar();
  pdf('Portugues', 'Aula.pdf');
  mt.escanearPasta(db, planoId, raiz);
  const [m] = mt.listarMateriais(db, planoId);
  const ret = [[0.1, 0.2, 0.5, 0.02]];
  // Antes de abrir no leitor o PDF não tem impressão digital: não dá para marcar.
  assert.throws(() => mt.marcar(db, m.id, { pagina: 1, tipo: 'grifo', cor: 'amarelo', retangulos: ret, texto: 'Crase' }), /Abra o PDF/);
  mt.lerPdf(db, m.id);
  mt.guardarPagina(db, m.id, 1, 10);
  const grifo = mt.marcar(db, m.id, { pagina: 3, tipo: 'grifo', cor: 'amarelo', retangulos: [[0.1, 0.6, 0.5, 0.02]], texto: '  A crase\n é a fusão ' });
  assert.equal(grifo.texto, 'A crase é a fusão');
  mt.marcar(db, m.id, { pagina: 3, tipo: 'sublinhado', cor: 'azul', retangulos: ret, texto: 'Topo' });
  mt.marcar(db, m.id, { pagina: 1, tipo: 'nota', cor: 'rosa', retangulos: [[0.5, 0.5, 0.03, 0.02]], nota: 'Revisar\nisto' });
  // Ordem de leitura: página, depois de cima para baixo.
  assert.deepEqual(mt.listarMarcacoes(db, m.id).map((x) => x.texto || x.nota), ['Revisar\nisto', 'Topo', 'A crase é a fusão']);

  const editado = mt.editarMarcacao(db, grifo.id, { cor: 'verde', tipo: 'sublinhado', nota: 'cai muito' });
  assert.deepEqual([editado.cor, editado.tipo, editado.nota, editado.texto], ['verde', 'sublinhado', 'cai muito', 'A crase é a fusão']);
  assert.equal(mt.editarMarcacao(db, grifo.id, { nota: '   ' }).nota, null);
  mt.apagarMarcacao(db, grifo.id);
  assert.equal(mt.listarMarcacoes(db, m.id).length, 2);
  assert.equal(mt.lerPdf(db, m.id).toString(), '%PDF-1.4 teste');
  limpar();
});

test('marcação recusa dado torto vindo da tela', () => {
  const { db, planoId, raiz, pdf, limpar } = preparar();
  pdf('Portugues', 'Aula.pdf');
  mt.escanearPasta(db, planoId, raiz);
  const [m] = mt.listarMateriais(db, planoId);
  mt.lerPdf(db, m.id);
  mt.guardarPagina(db, m.id, 1, 5);
  const base = { pagina: 1, tipo: 'grifo', cor: 'amarelo', retangulos: [[0.1, 0.1, 0.2, 0.02]], texto: 'x' };
  assert.throws(() => mt.marcar(db, m.id, { ...base, pagina: 6 }), /fora do PDF/);
  assert.throws(() => mt.marcar(db, m.id, { ...base, cor: '#f00' }), /Cor desconhecida/);
  assert.throws(() => mt.marcar(db, m.id, { ...base, tipo: 'tachado' }), /Tipo/);
  assert.throws(() => mt.marcar(db, m.id, { ...base, retangulos: [] }), /retângulos/);
  assert.throws(() => mt.marcar(db, m.id, { ...base, retangulos: [[0, 0, 3, 1]] }), /fora da página/);
  assert.throws(() => mt.marcar(db, m.id, { ...base, texto: 'a'.repeat(5001) }), /5000/);
  const nota = mt.marcar(db, m.id, { ...base, tipo: 'nota', texto: '' });
  assert.throws(() => mt.editarMarcacao(db, nota.id, { tipo: 'grifo' }), /Só grifo e sublinhado/);
  limpar();
});

test('marcações seguem o arquivo: mover o PDF de pasta não perde nada', () => {
  const { db, planoId, raiz, pdf, limpar } = preparar();
  pdf('Portugues', 'Aula.pdf');
  mt.escanearPasta(db, planoId, raiz);
  const [antes] = mt.listarMateriais(db, planoId);
  mt.lerPdf(db, antes.id);
  mt.marcar(db, antes.id, { pagina: 1, tipo: 'grifo', cor: 'verde', retangulos: [[0.1, 0.1, 0.2, 0.02]], texto: 'Crase' });
  rmSync(join(raiz, 'Portugues'), { recursive: true });
  pdf('Raciocinio Logico', 'Aula movida.pdf');
  mt.escanearPasta(db, planoId, raiz);
  const [depois] = mt.listarMateriais(db, planoId);
  assert.notEqual(depois.id, antes.id);
  mt.lerPdf(db, depois.id);
  assert.deepEqual(mt.listarMarcacoes(db, depois.id).map((x) => x.texto), ['Crase']);
  const doPlano = mt.marcacoesDoPlano(db, planoId);
  assert.deepEqual(doPlano.map((x) => [x.material, x.materia, x.texto]), [['Aula movida', 'Raciocínio Lógico-Matemático', 'Crase']]);
  limpar();
});

test('banco da 1.1 ganha a coluna e a tabela das marcações sem perder material', () => {
  const db = abrirBanco(':memory:');
  db.exec(`CREATE TABLE material (id INTEGER PRIMARY KEY, plano_id INTEGER NOT NULL, materia_id INTEGER, caminho TEXT NOT NULL,
    nome TEXT NOT NULL, pasta TEXT NOT NULL DEFAULT '', paginas INTEGER, ultima_pagina INTEGER NOT NULL DEFAULT 1, aberto_em TEXT,
    UNIQUE (plano_id, caminho));
    INSERT INTO plano (id, nome) VALUES (1, 'Velho');
    INSERT INTO material (plano_id, caminho, nome, ultima_pagina) VALUES (1, 'C:/x.pdf', 'x', 9);`);
  mt.prepararMateriais(db);
  assert.equal(mt.obterMaterial(db, 1).ultima_pagina, 9);
  assert.equal(mt.obterMaterial(db, 1).arquivo, null);
  assert.deepEqual(mt.listarMarcacoes(db, 1), []);
  mt.prepararMateriais(db); // de novo, sem erro
});
