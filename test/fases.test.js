import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { abrirBanco, copiarBanco } from '../src/db.js';
import { importarEdital } from '../src/edital.js';
import { gerarCiclo, montarBlocos, opcoesDoCiclo, sincronizarFase, topicoSugerido } from '../src/ciclo.js';
import * as fases from '../src/fases.js';
import * as s from '../src/servico.js';
import * as q from '../src/questoes.js';
import { montarSimulado, corrigirSimulado, listarSimulados } from '../src/simulado.js';

const AREAS = ['Pediatria', 'Cirurgia', 'Medicina Preventiva e Social', 'Clínica Médica', 'Ginecologia e Obstetrícia'];
const EDITAL = AREAS.map((a, i) =>
  `### ${a} (20)\n- [ ] ${i === 1 ? 'Cirurgia pediátrica / Estenose hipertrófica do piloro' : 'Assunto 1'}\n- [ ] Trauma / Politrauma\n- [ ] Cirurgia pediátrica / Invaginação`).join('\n');

function planoResidencia(caminho = ':memory:') {
  const db = abrirBanco(caminho);
  const { planoId } = importarEdital(db, { nomePlano: 'Residência', markdown: EDITAL });
  gerarCiclo(db, planoId);
  const ids = Object.fromEntries(db.prepare('SELECT nome, id FROM materia WHERE plano_id = ?').all(planoId).map((m) => [m.nome, m.id]));
  return { db, planoId, ids };
}

const configPediatria = (ids, extra = {}) => AREAS.map((a) => ({
  materia_id: ids[a],
  peso: a === 'Pediatria' ? 9 : 1,
  tipo: a === 'Ginecologia e Obstetrícia' ? 'revisao' : 'teoria',
  ...extra[a],
}));

test('fase com Pediatria 9 para 1: 65 a 70% do conteúdo, GO em revisão e bloco de questões misturadas', () => {
  const { db, planoId, ids } = planoResidencia();
  fases.definirFase(db, planoId, {
    nome: 'Pediatria', inicio: '2026-08-21', fim: '2026-11-29',
    minutos_por_volta: 780, questoes_mistas_min: 120, materias: configPediatria(ids),
  });
  const { blocos } = gerarCiclo(db, planoId, {}, { hoje: '2026-10-20' });
  const conteudo = blocos.filter((b) => b.materia);
  const total = conteudo.reduce((a, b) => a + b.duracao, 0);
  const pediatria = conteudo.filter((b) => b.materia.nome === 'Pediatria').reduce((a, b) => a + b.duracao, 0);
  assert.ok(pediatria / total >= 0.65 && pediatria / total <= 0.7, `Pediatria com ${pediatria} de ${total}`);
  const go = conteudo.filter((b) => b.materia.nome === 'Ginecologia e Obstetrícia');
  assert.ok(go.length > 0 && go.every((b) => b.tipo === 'revisao'));
  const mistos = blocos.filter((b) => !b.materia);
  assert.equal(mistos.length, 1);
  assert.deepEqual([mistos[0].tipo, mistos[0].duracao], ['questoes', 120]);
  assert.equal(blocos.at(-1), mistos[0], 'o bloco misturado fecha a volta');

  const gravado = s.cicloDoPlano(db, planoId);
  assert.equal(gravado.fase.nome, 'Pediatria');
  assert.equal(gravado.tempo_total_min, 780);
  assert.ok(gravado.blocos.find((b) => b.misto && b.materia_id === null && b.tipo === 'questoes'));
});

test('plano sem fase: ciclo igual ao de antes e nenhuma virada', () => {
  const { db, planoId } = planoResidencia();
  const materias = db.prepare('SELECT id, nome, conhecimento, importancia FROM materia WHERE plano_id = ? ORDER BY posicao').all(planoId);
  const esperado = montarBlocos(materias).map((b) => [b.materia.id, b.volta, b.duracao]);
  const gravado = s.cicloDoPlano(db, planoId);
  assert.deepEqual(gravado.blocos.map((b) => [b.materia_id, b.volta, b.duracao_min]), esperado);
  assert.ok(gravado.blocos.every((b) => b.tipo === 'teoria' && !b.misto));
  assert.equal(gravado.fase_id, null);
  let copias = 0;
  assert.equal(sincronizarFase(db, planoId, { copiar: () => copias++ }), null);
  assert.equal(copias, 0);
  assert.equal(s.resumo(db, planoId).modoSemana, 'meta');
});

test('virada de fase: refaz o ciclo uma vez, com cópia do banco, e a segunda chamada não refaz', () => {
  const pasta = mkdtempSync(join(tmpdir(), 'fases-'));
  const caminho = join(pasta, 'estudos.db');
  const { db, planoId, ids } = planoResidencia(caminho);
  fases.definirFase(db, planoId, { nome: 'Pediatria', inicio: '2026-08-21', fim: '2026-11-29', minutos_por_volta: 780, materias: configPediatria(ids) });
  fases.definirFase(db, planoId, {
    nome: 'Férias', inicio: '2026-11-30', fim: '2026-12-21',
    materias: AREAS.map((a) => ({ materia_id: ids[a], fora: a === 'Pediatria' })),
  });
  const copiar = (motivo) => copiarBanco(db, caminho, motivo);

  assert.deepEqual(sincronizarFase(db, planoId, { hoje: '2026-10-20', copiar }), { de: null, para: 'Pediatria' });
  s.pularBloco(db, s.proximoBloco(db, planoId).id);
  const virada = sincronizarFase(db, planoId, { hoje: '2026-12-01', copiar });
  assert.deepEqual(virada, { de: 'Pediatria', para: 'Férias' });
  assert.equal(sincronizarFase(db, planoId, { hoje: '2026-12-02', copiar }), null);

  const copias = readdirSync(join(pasta, 'copias')).filter((f) => f.includes('virada de fase'));
  assert.ok(copias.length >= 1, 'cópia antes da virada');
  const ciclo = s.cicloDoPlano(db, planoId);
  assert.equal(ciclo.fase.nome, 'Férias');
  assert.ok(ciclo.blocos.every((b) => !b.feito), 'a fila recomeça');
  assert.ok(!ciclo.blocos.some((b) => b.materia === 'Pediatria'), 'Pediatria fora da fase');
  assert.equal(ciclo.tempo_total_min, 840, 'Férias não define minutos: volta ao tempo do plano');

  // Depois da última fase, o ciclo volta ao padrão do plano.
  assert.deepEqual(sincronizarFase(db, planoId, { hoje: '2027-01-10', copiar }), { de: 'Férias', para: null });
  assert.equal(s.cicloDoPlano(db, planoId).fase, null);
  assert.equal(opcoesDoCiclo(db, planoId).total, 840);
  db.close();
});

test('fase com peso manual em só parte das matérias é recusada com mensagem clara', () => {
  const { db, planoId, ids } = planoResidencia();
  assert.throws(
    () => fases.definirFase(db, planoId, { nome: 'X', inicio: '2026-01-01', fim: '2026-01-31', materias: [{ materia_id: ids.Pediatria, peso: 9 }] }),
    /Peso manual precisa valer para todas as matérias ativas da fase\. Faltou em: Cirurgia/,
  );
  // Com as outras fora da fase, vale.
  const fora = AREAS.filter((a) => a !== 'Pediatria').map((a) => ({ materia_id: ids[a], fora: true }));
  fases.definirFase(db, planoId, { nome: 'X', inicio: '2026-01-01', fim: '2026-01-31', materias: [{ materia_id: ids.Pediatria, peso: 9 }, ...fora] });
  assert.equal(fases.listarFases(db, planoId).length, 1);
});

test('fases do mesmo plano não se sobrepõem, e atualizar pelo nome mantém o que não foi enviado', () => {
  const { db, planoId, ids } = planoResidencia();
  fases.definirFase(db, planoId, { nome: 'A', inicio: '2026-01-01', fim: '2026-01-31', teto_semanal_min: 1200, materias: configPediatria(ids) });
  assert.throws(() => fases.definirFase(db, planoId, { nome: 'B', inicio: '2026-01-31', fim: '2026-02-10' }), /sobrepõe à fase "A"/);
  assert.throws(() => fases.definirFase(db, planoId, { nome: 'B', inicio: '2026-03-10', fim: '2026-03-01' }), /início da fase vem depois/);
  const a = fases.definirFase(db, planoId, { nome: 'A', fim: '2026-02-15' });
  assert.equal(a.teto_semanal_min, 1200);
  assert.equal(a.materias.find((m) => m.materia === 'Pediatria').peso, 9);
  fases.apagarFase(db, planoId, 'A');
  assert.equal(fases.listarFases(db, planoId).length, 0);
});

test('grupo de foco: sugere o assunto aberto do grupo e, sem ele, volta à ordem normal', () => {
  const { db, planoId, ids } = planoResidencia();
  const cirurgia = ids.Cirurgia;
  assert.equal(topicoSugerido(db, cirurgia).nome, 'Cirurgia pediátrica / Estenose hipertrófica do piloro');
  assert.equal(topicoSugerido(db, cirurgia, 'Trauma').nome, 'Trauma / Politrauma');
  db.prepare("UPDATE topico SET concluido = 1 WHERE materia_id = ? AND nome LIKE 'Trauma%'").run(cirurgia);
  assert.equal(topicoSugerido(db, cirurgia, 'Trauma').nome, 'Cirurgia pediátrica / Estenose hipertrófica do piloro');
  assert.equal(topicoSugerido(db, cirurgia, '50%_').nome, 'Cirurgia pediátrica / Estenose hipertrófica do piloro', 'curinga do LIKE não vaza');

  fases.definirFase(db, planoId, {
    nome: 'Rodízio', inicio: '2000-01-01', fim: '2100-01-01',
    materias: AREAS.map((a) => ({ materia_id: ids[a], fora: a !== 'Cirurgia', grupo_foco: a === 'Cirurgia' ? 'Cirurgia pediátrica' : null })),
  });
  sincronizarFase(db, planoId);
  const p = s.proximoBloco(db, planoId);
  assert.equal(p.materia, 'Cirurgia');
  assert.equal(p.grupo_foco, 'Cirurgia pediátrica');
  assert.equal(p.fase, 'Rodízio');
});

test('modo teto: o teto vem da fase ativa ou do plano', () => {
  const { db, planoId, ids } = planoResidencia();
  db.prepare("UPDATE plano SET modo_semana = 'teto', teto_semanal_min = 1500 WHERE id = ?").run(planoId);
  assert.deepEqual([s.resumo(db, planoId).modoSemana, s.resumo(db, planoId).tetoSemanal], ['teto', 1500]);
  fases.definirFase(db, planoId, { nome: 'F', inicio: '2000-01-01', fim: '2100-01-01', teto_semanal_min: 1200, materias: configPediatria(ids) });
  assert.equal(s.resumo(db, planoId).tetoSemanal, 1200);
});

function comQuestoes() {
  const ctx = planoResidencia();
  const { db, planoId, ids } = ctx;
  q.prepararQuestoes(db);
  const alt = ['a', 'b', 'c', 'd'];
  for (const [lote, n] of [['Prova SUS 2024', 10], ['Prova UEL 2025', 5], ['claude/Prova UEL 2026', 5]]) {
    for (const area of AREAS) {
      const origem = lote.replace(/^claude\//, '');
      q.adicionarQuestoes(db, planoId, {
        origem: lote, materiaId: ids[area],
        questoes: Array.from({ length: n / 5 * 2 }, (_, i) => ({ enunciado: `${origem} ${area} ${i}`, alternativas: alt, correta: 0 })),
      });
    }
  }
  return ctx;
}

test('lote reservado: fora da listagem padrão e do bloco misturado, aparece quando pedido e libera sozinho', () => {
  const { db, planoId } = comQuestoes();
  const total = q.listarQuestoes(db, planoId, { limite: 1000 }).length;
  q.reservarLote(db, planoId, 'Prova UEL 2025', { liberaEm: '2027-09-01' });
  q.reservarLote(db, planoId, 'Prova UEL 2026'); // achado pelo prefixo claude/
  const padrao = q.listarQuestoes(db, planoId, { limite: 1000, hoje: '2026-10-20' });
  assert.equal(padrao.length, total - 20);
  assert.ok(padrao.every((x) => !/UEL/.test(x.origem)));
  const misturado = q.listarQuestoes(db, planoId, { limite: 1000, aleatoria: true, hoje: '2026-10-20' });
  assert.ok(misturado.every((x) => !/UEL/.test(x.origem)), 'bloco misturado sem reservados');
  assert.equal(q.listarQuestoes(db, planoId, { lote: 'Prova UEL 2025', limite: 1000, hoje: '2026-10-20' }).length, 10);
  assert.equal(q.listarQuestoes(db, planoId, { incluirReservados: true, limite: 1000, hoje: '2026-10-20' }).length, total);
  const depois = q.listarQuestoes(db, planoId, { limite: 1000, hoje: '2027-09-01' });
  assert.equal(depois.length, total - 10, 'UEL 2025 liberado na data; UEL 2026 continua reservado');
  const lotes = q.listarLotes(db, planoId, '2026-10-20');
  assert.deepEqual(lotes.filter((l) => l.reservado).map((l) => l.lote).sort(), ['Prova UEL 2025', 'claude/Prova UEL 2026']);
  q.reservarLote(db, planoId, 'Prova UEL 2026', { reservado: false });
  assert.throws(() => q.reservarLote(db, planoId, 'Prova XYZ'), /não encontrado/);
});

test('simulado: X por matéria, reservado só quando pedido, correção grava respostas, estudos e resultado', () => {
  const { db, planoId, ids } = comQuestoes();
  q.reservarLote(db, planoId, 'Prova UEL 2025');
  const porMateria = Object.fromEntries(AREAS.map((a) => [ids[a], 2]));
  const comum = montarSimulado(db, planoId, { porMateria });
  assert.equal(comum.questoes.length, 10);
  assert.ok(comum.questoes.every((x) => x.origem !== 'Prova UEL 2025'));
  const uel = montarSimulado(db, planoId, { porMateria: Object.fromEntries(AREAS.map((a) => [ids[a], 5])), lote: 'Prova UEL 2025' });
  assert.equal(uel.questoes.length, 10);
  assert.equal(uel.faltas.length, 5, 'avisa quando o lote não tem o tanto pedido');

  const respostas = comum.questoes.map((x, i) => ({ questao_id: x.id, escolhida: i < 6 ? 0 : i < 9 ? 1 : null, segundos: 60 }));
  const r = corrigirSimulado(db, planoId, { respostas, minutos: 30 });
  assert.equal(r.acertos, 6);
  assert.equal(r.por_materia.reduce((a, m) => a + m.questoes, 0), 10);
  assert.equal(r.por_materia.reduce((a, m) => a + m.em_branco, 0), 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM resposta').get().n, 9, 'em branco não grava resposta');
  const sessoes = s.historico(db, planoId);
  assert.equal(sessoes.length, 5);
  assert.equal(sessoes.reduce((a, x) => a + x.acertos + x.erros, 0), 10);
  assert.equal(listarSimulados(db, planoId)[0].acertos, 6);
});

// Esquema da 1.0.5 (db.js e questoes.js daquela versão), para testar a migração.
const ESQUEMA_1_0_5 = `
CREATE TABLE plano (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, data_prova TEXT, criado_em TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE materia (id INTEGER PRIMARY KEY, plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE, nome TEXT NOT NULL, cor TEXT,
  conhecimento REAL NOT NULL DEFAULT 2.5, importancia REAL NOT NULL DEFAULT 2.5, posicao INTEGER NOT NULL, UNIQUE (plano_id, nome));
CREATE TABLE topico (id INTEGER PRIMARY KEY, materia_id INTEGER NOT NULL REFERENCES materia(id) ON DELETE CASCADE, numero INTEGER NOT NULL, nome TEXT NOT NULL, concluido INTEGER NOT NULL DEFAULT 0);
CREATE TABLE ciclo (id INTEGER PRIMARY KEY, plano_id INTEGER NOT NULL UNIQUE REFERENCES plano(id) ON DELETE CASCADE, tempo_total_min INTEGER NOT NULL,
  bloco_min INTEGER NOT NULL, bloco_max INTEGER NOT NULL, passo_min INTEGER NOT NULL);
CREATE TABLE bloco (id INTEGER PRIMARY KEY, ciclo_id INTEGER NOT NULL REFERENCES ciclo(id) ON DELETE CASCADE, materia_id INTEGER NOT NULL REFERENCES materia(id) ON DELETE CASCADE,
  volta INTEGER NOT NULL DEFAULT 1, posicao INTEGER NOT NULL, duracao_min INTEGER NOT NULL, feito INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessao (id INTEGER PRIMARY KEY, plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE, materia_id INTEGER REFERENCES materia(id) ON DELETE SET NULL,
  topico_id INTEGER REFERENCES topico(id) ON DELETE SET NULL, inicio TEXT NOT NULL, duracao_min INTEGER NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('teoria', 'questoes', 'revisao')), acertos INTEGER NOT NULL DEFAULT 0, erros INTEGER NOT NULL DEFAULT 0, anotacao TEXT,
  origem TEXT NOT NULL DEFAULT 'app' CHECK (origem IN ('app', 'claude')));
CREATE TABLE revisao (id INTEGER PRIMARY KEY, sessao_id INTEGER NOT NULL REFERENCES sessao(id) ON DELETE CASCADE, data_prevista TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'feita', 'pulada')));
CREATE TABLE preferencia (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
INSERT INTO preferencia VALUES ('intervalos_revisao', '[1,7,30,60,120]'), ('minutos_constancia', '20'), ('versao_do_app', '"1.0.5"');
CREATE TABLE questao (id INTEGER PRIMARY KEY, plano_id INTEGER NOT NULL REFERENCES plano(id) ON DELETE CASCADE, materia_id INTEGER REFERENCES materia(id) ON DELETE SET NULL,
  origem TEXT NOT NULL, numero INTEGER NOT NULL, fonte TEXT, tema TEXT, enunciado TEXT NOT NULL, alternativas TEXT NOT NULL, correta INTEGER NOT NULL, comentario TEXT,
  UNIQUE (plano_id, origem, numero));
CREATE TABLE resposta (id INTEGER PRIMARY KEY, questao_id INTEGER NOT NULL REFERENCES questao(id) ON DELETE CASCADE, escolhida INTEGER NOT NULL, acertou INTEGER NOT NULL,
  respondida_em TEXT NOT NULL DEFAULT (datetime('now', 'localtime')), segundos INTEGER, causa TEXT);
`;

test('banco da 1.0.5 populado abre na 1.1 sem perder nada', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const caminho = join(mkdtempSync(join(tmpdir(), 'migra-')), 'estudos.db');
  const velho = new DatabaseSync(caminho);
  velho.exec(ESQUEMA_1_0_5);
  velho.exec("INSERT INTO plano (id, nome) VALUES (1, 'Residência Médica 2027')");
  AREAS.forEach((a, i) => velho.prepare('INSERT INTO materia (id, plano_id, nome, importancia, posicao) VALUES (?, 1, ?, 20, ?)').run(i + 1, a, i + 1));
  for (let t = 0; t < 205; t++) velho.prepare('INSERT INTO topico (materia_id, numero, nome) VALUES (?, ?, ?)').run((t % 5) + 1, Math.floor(t / 5) + 1, `Grupo / Assunto ${t}`);
  for (let k = 0; k < 660; k++) {
    velho.prepare("INSERT INTO questao (plano_id, materia_id, origem, numero, enunciado, alternativas, correta) VALUES (1, ?, ?, ?, 'e', '[\"a\",\"b\"]', 0)")
      .run((k % 5) + 1, `claude/Prova UEL ${2020 + (k % 6)}`, k);
  }
  velho.exec('INSERT INTO ciclo VALUES (1, 1, 840, 45, 90, 15)');
  for (let b = 0; b < 10; b++) velho.prepare('INSERT INTO bloco VALUES (?, 1, ?, 1, ?, ?, ?)').run(b + 1, (b % 5) + 1, b + 1, b < 5 ? 75 : 90, b < 3 ? 1 : 0);
  velho.close();

  const db = abrirBanco(caminho);
  q.prepararQuestoes(db);
  const contar = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  assert.deepEqual([contar('plano'), contar('materia'), contar('topico'), contar('questao'), contar('bloco')], [1, 5, 205, 660, 10]);
  const blocos = db.prepare('SELECT id, materia_id, posicao, duracao_min, feito, tipo FROM bloco ORDER BY id').all();
  assert.deepEqual(blocos.map((b) => [b.id, b.materia_id, b.duracao_min, b.feito, b.tipo]),
    Array.from({ length: 10 }, (_, b) => [b + 1, (b % 5) + 1, b < 5 ? 75 : 90, b < 3 ? 1 : 0, 'teoria']));
  assert.equal(db.prepare("SELECT \"notnull\" n FROM pragma_table_info('bloco') WHERE name = 'materia_id'").get().n, 0);
  assert.equal(s.proximoBloco(db, 1).id, 4, 'a fila continua de onde parou');
  assert.equal(sincronizarFase(db, 1), null);
  assert.equal(opcoesDoCiclo(db, 1).total, 840);
  db.close();
  // Abrir de novo não migra outra vez.
  const outra = abrirBanco(caminho);
  assert.equal(outra.prepare('SELECT COUNT(*) n FROM bloco').get().n, 10);
  outra.close();
});

test('banco aberto só para leitura e ainda não migrado não quebra', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const caminho = join(mkdtempSync(join(tmpdir(), 'leitura-')), 'estudos.db');
  const velho = new DatabaseSync(caminho);
  velho.exec(`CREATE TABLE plano (id INTEGER PRIMARY KEY, nome TEXT NOT NULL, data_prova TEXT, criado_em TEXT);
    CREATE TABLE materia (id INTEGER PRIMARY KEY, plano_id INTEGER, nome TEXT, cor TEXT, conhecimento REAL, importancia REAL, posicao INTEGER);
    CREATE TABLE topico (id INTEGER PRIMARY KEY, materia_id INTEGER, numero INTEGER, nome TEXT, concluido INTEGER DEFAULT 0);
    CREATE TABLE ciclo (id INTEGER PRIMARY KEY, plano_id INTEGER UNIQUE, tempo_total_min INTEGER, bloco_min INTEGER, bloco_max INTEGER, passo_min INTEGER);
    CREATE TABLE bloco (id INTEGER PRIMARY KEY, ciclo_id INTEGER, materia_id INTEGER NOT NULL, volta INTEGER, posicao INTEGER, duracao_min INTEGER, feito INTEGER DEFAULT 0);
    CREATE TABLE preferencia (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
    INSERT INTO preferencia VALUES ('intervalos_revisao', '[1,7,30]'), ('minutos_constancia', '20');
    INSERT INTO plano (id, nome) VALUES (1, 'P');
    INSERT INTO materia VALUES (1, 1, 'A', NULL, 2.5, 2.5, 1);
    INSERT INTO topico VALUES (1, 1, 1, 'T', 0);
    INSERT INTO ciclo VALUES (1, 1, 840, 45, 90, 15);
    INSERT INTO bloco VALUES (1, 1, 1, 1, 1, 90, 0);`);
  velho.close();
  const db = new DatabaseSync(caminho, { readOnly: true });
  assert.equal(fases.faseAtiva(db, 1), null);
  assert.equal(sincronizarFase(db, 1), null);
  const p = s.proximoBloco(db, 1, { reiniciar: false });
  assert.deepEqual([p.materia, p.tipo, p.topico.nome], ['A', 'teoria', 'T']);
  assert.equal(fases.semanaDoPlano(db, 1).modo, 'meta');
  db.close();
  assert.ok(existsSync(caminho));
});

test('app e MCP abrindo o banco da 1.0.5 ao mesmo tempo: um migra, nenhum quebra', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { spawn } = await import('node:child_process');
  for (let rodada = 0; rodada < 3; rodada++) {
    const caminho = join(mkdtempSync(join(tmpdir(), 'corrida-')), 'estudos.db');
    const velho = new DatabaseSync(caminho);
    velho.exec(ESQUEMA_1_0_5);
    velho.exec("INSERT INTO plano (id, nome) VALUES (1, 'P'); INSERT INTO materia (id, plano_id, nome, posicao) VALUES (1, 1, 'A', 1);");
    velho.exec('INSERT INTO ciclo VALUES (1, 1, 840, 45, 90, 15)');
    for (let b = 0; b < 50; b++) velho.prepare('INSERT INTO bloco VALUES (?, 1, 1, 1, ?, 60, 0)').run(b + 1, b + 1);
    velho.close();
    const abrir = `import { abrirBanco } from ${JSON.stringify(new URL('../src/db.js', import.meta.url).href)};
      const db = abrirBanco(process.argv[1]); console.log(db.prepare('SELECT COUNT(*) n FROM bloco').get().n); db.close();`;
    const processo = () => new Promise((ok) => {
      const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', abrir, caminho]);
      let saida = '';
      let erro = '';
      p.stdout.on('data', (d) => (saida += d));
      p.stderr.on('data', (d) => (erro += d));
      p.on('exit', (codigo) => ok({ codigo, saida: saida.trim(), erro }));
    });
    const resultados = await Promise.all([processo(), processo(), processo()]);
    for (const r of resultados) assert.deepEqual([r.codigo, r.saida], [0, '50'], r.erro);
  }
});
