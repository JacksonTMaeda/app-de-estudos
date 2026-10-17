import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/db.js';
import { importarEdital } from '../src/edital.js';
import { gerarCiclo } from '../src/ciclo.js';
import * as s from '../src/servico.js';

const EDITAL = `
### Português (20)
- [x] Interpretação
- [ ] Crase
### Lógica (10)
- [ ] Conjuntos
`;

function novoPlano() {
  const db = abrirBanco(':memory:');
  const { planoId } = importarEdital(db, { nomePlano: 'Teste', markdown: EDITAL });
  gerarCiclo(db, planoId, { total: 180 });
  return { db, planoId };
}

test('próximo bloco sugere o primeiro assunto aberto', () => {
  const { db, planoId } = novoPlano();
  const p = s.proximoBloco(db, planoId);
  assert.equal(p.materia, 'Português');
  assert.equal(p.topico.nome, 'Crase');
  assert.equal(p.progresso.feitos, 0);
});

test('registrar pelo bloco avança a fila e marca o assunto', () => {
  const { db, planoId } = novoPlano();
  const p = s.proximoBloco(db, planoId);
  s.registrarSessao(db, planoId, {
    materia_id: p.materia_id, topico_id: p.topico.id, bloco_id: p.id,
    tipo: 'questoes', duracao_min: 50, acertos: 8, erros: 2, topico_concluido: true,
  });
  const depois = s.proximoBloco(db, planoId);
  assert.notEqual(depois.id, p.id);
  assert.equal(depois.progresso.feitos, 1);
  assert.equal(db.prepare('SELECT concluido FROM topico WHERE id = ?').get(p.topico.id).concluido, 1);
});

test('fila recomeça quando todos os blocos foram feitos', () => {
  const { db, planoId } = novoPlano();
  const total = s.cicloDoPlano(db, planoId).blocos.length;
  for (let i = 0; i < total; i++) s.pularBloco(db, s.proximoBloco(db, planoId).id);
  const p = s.proximoBloco(db, planoId);
  assert.equal(p.posicao, 1);
  assert.equal(p.progresso.feitos, 0);
});

test('estudo agenda revisões em 1, 7, 30, 60 e 120 dias; revisão não agenda', () => {
  const { db, planoId } = novoPlano();
  s.registrarSessao(db, planoId, { tipo: 'teoria', duracao_min: 30, inicio: '2026-10-17T08:00' });
  s.registrarSessao(db, planoId, { tipo: 'revisao', duracao_min: 10, inicio: '2026-10-17T09:00' });
  const datas = db.prepare('SELECT data_prevista FROM revisao ORDER BY data_prevista').all().map((r) => r.data_prevista);
  assert.deepEqual(datas, ['2026-10-18', '2026-10-24', '2026-11-16', '2026-12-16', '2027-02-14']);
  assert.equal(s.revisoesDoDia(db, planoId, '2026-10-17').length, 0);
  const deAmanha = s.revisoesDoDia(db, planoId, '2026-10-18');
  assert.equal(deAmanha.length, 1);
  s.concluirRevisao(db, deAmanha[0].id);
  assert.equal(s.revisoesDoDia(db, planoId, '2026-10-18').length, 0);
});

test('resumo soma tempo, questões, edital e constância', () => {
  const { db, planoId } = novoPlano();
  s.registrarSessao(db, planoId, { tipo: 'questoes', duracao_min: 40, acertos: 7, erros: 3, inicio: '2026-10-16T20:00' });
  s.registrarSessao(db, planoId, { tipo: 'teoria', duracao_min: 15, inicio: '2026-10-17T07:00' });
  const r = s.resumo(db, planoId, '2026-10-17');
  assert.equal(r.hoje, 15);
  assert.equal(r.semana, 55); // semana começa no domingo, 11-10-2026
  assert.equal(r.questoes.desempenho, 0.7);
  assert.deepEqual(r.edital, { total: 3, feitos: 1 });
  assert.equal(r.constancia.at(-1).contou, false); // 15 min não chega aos 20
  assert.equal(r.constancia.at(-2).contou, true);
  assert.equal(r.diasSeguidos, 1); // hoje ainda em andamento não quebra a sequência
  assert.equal(r.metaSemanal, 180);
});

test('editar corrige os números e move as revisões pendentes junto com a data', () => {
  const { db, planoId } = novoPlano();
  const id = s.registrarSessao(db, planoId, { tipo: 'questoes', duracao_min: 30, acertos: 5, erros: 5, inicio: '2026-10-17T08:00' });
  s.concluirRevisao(db, s.revisoesDoDia(db, planoId, '2026-10-18')[0].id);
  const nova = s.editarSessao(db, id, { duracao_min: 45, acertos: 8, erros: 2, inicio: '2026-10-20T08:00' });
  assert.deepEqual([nova.duracao_min, nova.acertos, nova.erros, nova.inicio], [45, 8, 2, '2026-10-20T08:00']);
  const revisoes = db.prepare('SELECT data_prevista, estado FROM revisao WHERE sessao_id = ? ORDER BY id').all(id).map((r) => ({ ...r }));
  // A de 1 dia já foi feita e fica; as outras 4 são refeitas a partir de 20-10.
  assert.deepEqual(revisoes, [
    { data_prevista: '2026-10-18', estado: 'feita' },
    { data_prevista: '2026-10-27', estado: 'pendente' },
    { data_prevista: '2026-11-19', estado: 'pendente' },
    { data_prevista: '2026-12-19', estado: 'pendente' },
    { data_prevista: '2027-02-17', estado: 'pendente' },
  ]);
});

test('editar para revisão tira as revisões pendentes', () => {
  const { db, planoId } = novoPlano();
  const id = s.registrarSessao(db, planoId, { tipo: 'teoria', duracao_min: 30, inicio: '2026-10-17T08:00' });
  s.editarSessao(db, id, { tipo: 'revisao' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revisao WHERE sessao_id = ?").get(id).n, 0);
});

test('campos não enviados ficam como estavam', () => {
  const { db, planoId } = novoPlano();
  const id = s.registrarSessao(db, planoId, { tipo: 'teoria', duracao_min: 30, anotacao: 'nota', inicio: '2026-10-17T08:00' });
  const nova = s.editarSessao(db, id, { duracao_min: 40 });
  assert.deepEqual([nova.tipo, nova.anotacao, nova.inicio, nova.duracao_min], ['teoria', 'nota', '2026-10-17T08:00', 40]);
});

test('apagar tira o estudo e as revisões dele', () => {
  const { db, planoId } = novoPlano();
  const id = s.registrarSessao(db, planoId, { tipo: 'teoria', duracao_min: 30 });
  s.apagarSessao(db, id);
  assert.equal(s.historico(db, planoId).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revisao').get().n, 0);
});

test('próximo bloco em modo leitura não grava o recomeço', () => {
  const { db, planoId } = novoPlano();
  const total = s.cicloDoPlano(db, planoId).blocos.length;
  for (let i = 0; i < total; i++) s.pularBloco(db, s.proximoBloco(db, planoId).id);
  assert.equal(s.proximoBloco(db, planoId, { reiniciar: false }).posicao, 1);
  assert.equal(s.cicloDoPlano(db, planoId).blocos.every((b) => b.feito), true);
});

test('cópia de abertura: diária na primeira vez, e antes de qualquer ajuste quando a versão muda', async () => {
  const { mkdtempSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { copiaDeAbertura } = await import('../src/db.js');
  const caminho = join(mkdtempSync(join(tmpdir(), 'copia-')), 'estudos.db');
  const db = abrirBanco(caminho);
  importarEdital(db, { nomePlano: 'T', markdown: EDITAL });
  assert.match(copiaDeAbertura(db, caminho, '1.0.0'), /diaria/);
  assert.equal(copiaDeAbertura(db, caminho, '1.0.0'), null); // mesma versão, cópia de hoje já existe
  const antes = copiaDeAbertura(db, caminho, '1.1.0');
  assert.match(antes, /antes da versao 1\.1\.0/);
  const copia = abrirBanco(antes);
  assert.equal(copia.prepare('SELECT COUNT(*) n FROM topico').get().n, 3); // a cópia tem os dados
  assert.equal(readdirSync(join(caminho, '..', 'copias')).filter((f) => f.endsWith('.db')).length, 2);
});

test('sessão do Claude fica marcada', () => {
  const { db, planoId } = novoPlano();
  s.registrarSessao(db, planoId, { tipo: 'teoria', duracao_min: 20 }, 'claude');
  assert.equal(s.historico(db, planoId)[0].origem, 'claude');
});
