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
  const id = s.registrarSessao(db, planoId, { tipo: 'teoria', duracao_min: 30, acertos: 5, erros: 5, inicio: '2026-10-17T08:00' });
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

const materiaId = (db, nome) => db.prepare('SELECT id FROM materia WHERE nome = ?').get(nome).id;
const revisoesDe = (db, sessaoId) =>
  db.prepare('SELECT data_prevista, estado, concluida_por FROM revisao WHERE sessao_id = ? ORDER BY id').all(sessaoId).map((r) => ({ ...r }));

test('rodada de questões que serve de revisão conclui a vencida da matéria e não cria revisão nova', () => {
  const { db, planoId } = novoPlano();
  const pt = materiaId(db, 'Português');
  const teoria = s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'teoria', duracao_min: 60, inicio: '2026-11-02T13:00' });
  const outra = s.registrarSessao(db, planoId, { materia_id: materiaId(db, 'Lógica'), tipo: 'teoria', duracao_min: 30, inicio: '2026-11-02T15:00' });
  // Rodada do app no dia seguinte: a revisão de 1 dia de Português venceu.
  const rodada = s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'questoes', duracao_min: 20, acertos: 9, erros: 1, inicio: '2026-11-03T21:00' });
  assert.equal(revisoesDe(db, rodada).length, 0);
  assert.deepEqual(revisoesDe(db, teoria).map((r) => [r.data_prevista, r.estado, r.concluida_por]), [
    ['2026-11-03', 'feita', rodada],
    ['2026-11-09', 'pendente', null],
    ['2026-12-02', 'pendente', null],
    ['2027-01-01', 'pendente', null],
    ['2027-03-02', 'pendente', null],
  ]);
  // A outra matéria não é tocada.
  assert.equal(revisoesDe(db, outra)[0].estado, 'pendente');
  assert.deepEqual(s.revisoesConcluidasPor(db, rodada).map((r) => r.data_prevista), ['2026-11-03']);
  assert.deepEqual(s.revisoesDoDia(db, planoId, '2026-11-03').map((r) => r.materia), ['Lógica']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revisao').get().n, 10);
});

test('rodadas seguidas sem revisão vencida não criam revisão; atrasadas da matéria são concluídas juntas', () => {
  const { db, planoId } = novoPlano();
  const pt = materiaId(db, 'Português');
  const a = s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'teoria', duracao_min: 60, inicio: '2026-10-01T08:00' });
  const b = s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'teoria', duracao_min: 60, inicio: '2026-10-05T08:00' });
  const r1 = s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'questoes', duracao_min: 5, acertos: 1, inicio: '2026-10-09T21:00' });
  for (const h of ['21:10', '21:20', '21:30']) {
    s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'questoes', duracao_min: 2, acertos: 1, inicio: `2026-10-09T${h}` });
  }
  // As vencidas até 09-10 (1 dia de cada estudo e 7 dias do primeiro) saem com a primeira rodada.
  assert.deepEqual(s.revisoesConcluidasPor(db, r1).map((r) => [r.sessao_id, r.data_prevista]), [[a, '2026-10-02'], [b, '2026-10-06'], [a, '2026-10-08']]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM revisao r JOIN sessao s ON s.id = r.sessao_id WHERE s.tipo = 'questoes'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revisao').get().n, 10);
  assert.equal(s.revisoesDoDia(db, planoId, '2026-10-09').length, 0);
});

test('rodada sem matéria (misturada sem matéria) não conclui nem agenda nada', () => {
  const { db, planoId } = novoPlano();
  s.registrarSessao(db, planoId, { materia_id: materiaId(db, 'Português'), tipo: 'teoria', duracao_min: 60, inicio: '2026-11-02T13:00' });
  s.registrarSessao(db, planoId, { tipo: 'questoes', duracao_min: 10, acertos: 3, inicio: '2026-11-03T21:00' });
  assert.equal(s.revisoesDoDia(db, planoId, '2026-11-03').length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revisao').get().n, 5);
});

test('apagar a rodada devolve a revisão que ela concluiu', () => {
  const { db, planoId } = novoPlano();
  const pt = materiaId(db, 'Português');
  s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'teoria', duracao_min: 60, inicio: '2026-11-02T13:00' });
  const rodada = s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'questoes', duracao_min: 20, acertos: 9, erros: 1, inicio: '2026-11-03T21:00' });
  assert.equal(s.revisoesDoDia(db, planoId, '2026-11-03').length, 0);
  s.apagarSessao(db, rodada);
  const volta = s.revisoesDoDia(db, planoId, '2026-11-03');
  assert.deepEqual(volta.map((r) => r.data_prevista), ['2026-11-03']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM revisao WHERE concluida_por IS NOT NULL').get().n, 0);
});

test('corrigir a data ou a matéria da rodada refaz o que ela concluiu', () => {
  const { db, planoId } = novoPlano();
  const pt = materiaId(db, 'Português');
  const lg = materiaId(db, 'Lógica');
  s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'teoria', duracao_min: 60, inicio: '2026-11-02T13:00' });
  s.registrarSessao(db, planoId, { materia_id: lg, tipo: 'teoria', duracao_min: 60, inicio: '2026-11-02T15:00' });
  const rodada = s.registrarSessao(db, planoId, { materia_id: pt, tipo: 'questoes', duracao_min: 20, acertos: 9, inicio: '2026-11-03T21:00' });
  // Na verdade foi no mesmo dia da teoria: nada tinha vencido ainda.
  s.editarSessao(db, rodada, { inicio: '2026-11-02T21:00' });
  assert.equal(s.revisoesConcluidasPor(db, rodada).length, 0);
  assert.equal(s.revisoesDoDia(db, planoId, '2026-11-03').length, 2);
  // Volta para 03-11, mas era de Lógica.
  s.editarSessao(db, rodada, { inicio: '2026-11-03T21:00', materia_id: lg });
  assert.deepEqual(s.revisoesDoDia(db, planoId, '2026-11-03').map((r) => r.materia), ['Português']);
  assert.equal(revisoesDe(db, rodada).length, 0);
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

test('cópias: o teto é por motivo, e uma leva de "antes de apagar" não expulsa as diárias nem as de versão', async () => {
  const { mkdtempSync, mkdirSync, readdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { copiarBanco, COPIAS_GUARDADAS, grupoDaCopia } = await import('../src/db.js');
  const caminho = join(mkdtempSync(join(tmpdir(), 'teto-')), 'estudos.db');
  const db = abrirBanco(caminho);
  const pasta = join(caminho, '..', 'copias');
  mkdirSync(pasta);
  const z = (n) => String(n).padStart(2, '0');
  // Cópias antigas de mentira, cada grupo com 5 além do teto, e duas feitas à mão (fora do padrão de nome).
  const criar = (quantas, motivo, mes) => {
    for (let i = 0; i < quantas; i++) writeFileSync(join(pasta, `estudos 2020-${mes}-${z(1 + (i % 28))} ${z(i)}0000 ${motivo}.db`), '');
  };
  criar(COPIAS_GUARDADAS.diaria + 5, 'diaria', '01');
  criar(COPIAS_GUARDADAS.versao + 5, 'antes da versao 1.0.0', '02');
  criar(COPIAS_GUARDADAS.outras + 5, 'antes de apagar questao', '03');
  writeFileSync(join(pasta, 'estudos antes de apagar teste de crase.db'), '');
  writeFileSync(join(pasta, 'minha copia.db'), '');

  const nova = copiarBanco(db, caminho, 'antes de apagar questao');
  const ficaram = readdirSync(pasta);
  const doGrupo = (g) => ficaram.filter((f) => grupoDaCopia(f) === g);
  assert.equal(doGrupo('diaria').length, COPIAS_GUARDADAS.diaria);
  assert.equal(doGrupo('versao').length, COPIAS_GUARDADAS.versao);
  assert.equal(doGrupo('outras').length, COPIAS_GUARDADAS.outras);
  assert.ok(ficaram.some((f) => nova.endsWith(f)), 'a cópia nova fica');
  // Saem as mais velhas de cada grupo; as feitas à mão o programa não apaga.
  assert.ok(!ficaram.includes('estudos 2020-03-01 000000 antes de apagar questao.db'));
  assert.ok(ficaram.includes('estudos antes de apagar teste de crase.db') && ficaram.includes('minha copia.db'));
  assert.equal(ficaram.length, COPIAS_GUARDADAS.diaria + COPIAS_GUARDADAS.versao + COPIAS_GUARDADAS.outras + 2);
});

test('sessão do Claude fica marcada', () => {
  const { db, planoId } = novoPlano();
  s.registrarSessao(db, planoId, { tipo: 'teoria', duracao_min: 20 }, 'claude');
  assert.equal(s.historico(db, planoId)[0].origem, 'claude');
});

test('estudo guarda o PDF e as páginas, desvira a ordem e mantém o nome se o PDF sair da lista', async () => {
  const { prepararMateriais } = await import('../src/materiais.js');
  const { db, planoId } = novoPlano();
  prepararMateriais(db);
  const materialId = Number(db.prepare("INSERT INTO material (plano_id, caminho, nome) VALUES (?, 'C:/x/aula 9.pdf', 'Aula 9')").run(planoId).lastInsertRowid);
  const id = s.registrarSessao(db, planoId, { tipo: 'teoria', duracao_min: 30, material_id: materialId, pagina_de: 21, pagina_ate: 9 });
  let r = s.obterSessao(db, id);
  assert.deepEqual([r.material_id, r.material_nome, r.pagina_de, r.pagina_ate], [materialId, 'Aula 9', 9, 21]);
  assert.equal(s.historico(db, planoId)[0].material, 'Aula 9');

  // Arquivo renomeado: o material sai da lista, o estudo continua dizendo o que foi lido, e dá para corrigir as páginas.
  db.prepare('DELETE FROM material WHERE id = ?').run(materialId);
  r = s.editarSessao(db, id, { pagina_ate: 25 });
  assert.deepEqual([r.material_nome, r.pagina_de, r.pagina_ate], ['Aula 9', 9, 25]);

  // Sem PDF, as páginas saem junto.
  r = s.editarSessao(db, id, { material_id: null });
  assert.deepEqual([r.material_id, r.material_nome, r.pagina_de, r.pagina_ate], [null, null, null, null]);
  assert.throws(() => s.registrarSessao(db, planoId, { tipo: 'teoria', material_id: 999 }), /não existe/);
});
