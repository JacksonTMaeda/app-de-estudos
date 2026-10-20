import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { abrirBanco } from '../src/db.js';
import { importarEdital } from '../src/edital.js';
import { gerarCiclo } from '../src/ciclo.js';
import * as s from '../src/servico.js';
import { prepararQuestoes } from '../src/questoes.js';

function bancoDeTeste() {
  const caminho = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'estudos.db');
  const db = abrirBanco(caminho);
  const { planoId } = importarEdital(db, { nomePlano: 'PCPR', markdown: '### Português (20)\n- [x] Interpretação\n- [ ] Crase\n### Lógica (10)\n- [ ] Conjuntos' });
  gerarCiclo(db, planoId, { total: 180 });
  s.registrarSessao(db, planoId, { materia_id: 1, tipo: 'questoes', duracao_min: 40, acertos: 8, erros: 2, inicio: `${s.dataLocal()}T07:00`, anotacao: 'ok' });
  prepararQuestoes(db); // o programa faz isto ao abrir
  db.close();
  return caminho;
}

// Conversa com o servidor como um cliente MCP: uma mensagem por linha, espera a resposta de cada id.
function conversar(caminho) {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/mcp.js'], {
    env: { ...process.env, ESTUDOS_DB: caminho },
  });
  const esperando = new Map();
  createInterface({ input: proc.stdout }).on('line', (l) => {
    const msg = JSON.parse(l);
    esperando.get(msg.id)?.(msg);
  });
  let id = 0;
  return {
    pedir(method, params) {
      const meu = ++id;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: meu, method, params })}\n`);
      return new Promise((ok) => esperando.set(meu, ok));
    },
    avisar(method) {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    fechar() {
      proc.stdin.end();
      return new Promise((ok) => proc.on('exit', ok));
    },
  };
}

const chamarFerramenta = async (c, name, args = {}) => {
  const r = await c.pedir('tools/call', { name, arguments: args });
  return { erro: r.result.isError, dados: r.result.isError ? r.result.content[0].text : JSON.parse(r.result.content[0].text) };
};

test('servidor MCP responde o protocolo e as ferramentas de leitura', async (t) => {
  const c = conversar(bancoDeTeste());
  t.after(() => c.fechar()); // fecha o servidor mesmo se uma checagem falhar
  const init = await c.pedir('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'app-de-estudos');
  c.avisar('notifications/initialized');

  const lista = await c.pedir('tools/list', {});
  const porNome = Object.fromEntries(lista.result.tools.map((t) => [t.name, t.annotations]));
  for (const leitura of ['analise_questoes', 'assuntos_da_materia', 'historico_sessoes', 'proximo_estudo', 'resumo_periodo', 'revisoes_pendentes', 'ver_plano']) {
    assert.equal(porNome[leitura].readOnlyHint, true, leitura);
  }
  for (const apaga of ['apagar_estudo', 'apagar_questao', 'apagar_plano', 'refazer_ciclo']) {
    assert.equal(porNome[apaga].destructiveHint, true, apaga);
  }
  assert.equal(porNome.registrar_estudo.readOnlyHint, false);

  const plano = await chamarFerramenta(c, 'ver_plano');
  assert.equal(plano.dados.plano.nome, 'PCPR');
  assert.deepEqual(plano.dados.materias.map((m) => [m.nome, m.peso_no_ciclo_pct]), [['Português', 67], ['Lógica', 33]]);

  const proximo = await chamarFerramenta(c, 'proximo_estudo');
  assert.equal(proximo.dados.proximo.materia, 'Português');
  assert.equal(proximo.dados.proximo.assunto_sugerido, 'Crase');

  const resumo = await chamarFerramenta(c, 'resumo_periodo');
  assert.equal(resumo.dados.minutos, 40);
  assert.deepEqual(resumo.dados.questoes, { acertos: 8, erros: 2 });

  const hist = await chamarFerramenta(c, 'historico_sessoes', { limite: 5 });
  assert.equal(hist.dados.sessoes[0].anotacao, 'ok');

  const assuntos = await chamarFerramenta(c, 'assuntos_da_materia', { materia: 'portugues' });
  assert.deepEqual(assuntos.dados.assuntos.map((a) => a.concluido), [true, false]);

  const analise = await chamarFerramenta(c, 'analise_questoes');
  assert.equal(analise.dados.geral.respostas, 0);

  const revisoes = await chamarFerramenta(c, 'revisoes_pendentes', { ate: '2099-01-01' });
  assert.equal(revisoes.dados.total, 5);

  const ruim = await chamarFerramenta(c, 'assuntos_da_materia', { materia: 'Astronomia' });
  assert.ok(ruim.erro && /não encontrada/.test(ruim.dados));

  const desconhecido = await c.pedir('metodo/inexistente', {});
  assert.equal(desconhecido.error.code, -32601);
});

test('sem banco, a ferramenta explica o que fazer em vez de quebrar', async (t) => {
  const c = conversar(join(tmpdir(), 'nao-existe', 'estudos.db'));
  t.after(() => c.fechar());
  await c.pedir('initialize', { protocolVersion: '2024-11-05' });
  const r = await chamarFerramenta(c, 'ver_plano');
  assert.ok(r.erro && /não encontrado/.test(r.dados));
});

test('Claude registra, corrige e apaga estudo, com cópia do banco antes de apagar', async (t) => {
  const caminho = bancoDeTeste();
  const c = conversar(caminho);
  t.after(() => c.fechar());
  await c.pedir('initialize', { protocolVersion: '2025-06-18' });

  const reg = await chamarFerramenta(c, 'registrar_estudo', {
    materia: 'portu', assunto: 'crase', tipo: 'questoes', minutos: 30, acertos: 7, erros: 3, conta_no_ciclo: true, concluiu_assunto: true,
  });
  assert.equal(reg.erro, undefined, reg.dados);
  assert.equal(reg.dados.registrado.origem, 'claude');
  assert.equal(reg.dados.contou_no_ciclo, true);
  const id = reg.dados.registrado.id;

  const assuntos = await chamarFerramenta(c, 'assuntos_da_materia', { materia: 'Português' });
  assert.equal(assuntos.dados.assuntos[1].concluido, true);

  const cor = await chamarFerramenta(c, 'corrigir_estudo', { id, minutos: 45 });
  assert.deepEqual([cor.dados.corrigido.duracao_min, cor.dados.corrigido.acertos], [45, 7]);

  const apag = await chamarFerramenta(c, 'apagar_estudo', { id });
  assert.ok(existsSync(apag.dados.copia_do_banco));
  const hist = await chamarFerramenta(c, 'historico_sessoes');
  assert.ok(!hist.dados.sessoes.some((x) => x.id === id));

  const ruim = await chamarFerramenta(c, 'registrar_estudo', { materia: 'Química', tipo: 'teoria', minutos: 10 });
  assert.ok(ruim.erro && /não encontrada/.test(ruim.dados));
});

test('Claude acrescenta e apaga questões, refaz o ciclo e mexe em plano', async (t) => {
  const c = conversar(bancoDeTeste());
  t.after(() => c.fechar());
  await c.pedir('initialize', { protocolVersion: '2025-06-18' });

  const add = await chamarFerramenta(c, 'adicionar_questoes', {
    materia: 'Lógica',
    lote: 'teste',
    questoes: [
      { enunciado: 'p e q?', alternativas: ['V', 'F'], correta: 'B', fonte: 'AUTORAL', tema: 'Conectivos' },
      { enunciado: 'p ou q?', alternativas: ['V', 'F', 'Depende'], correta: 0 },
    ],
  });
  assert.equal(add.dados.adicionadas, 2);
  const invalida = await chamarFerramenta(c, 'adicionar_questoes', { materia: 'Lógica', lote: 't', questoes: [{ enunciado: 'x', alternativas: ['a'], correta: 0 }] });
  assert.ok(invalida.erro);
  const apagada = await chamarFerramenta(c, 'apagar_questao', { id: add.dados.ids[0] });
  assert.equal(apagada.dados.apagada.tema, 'Conectivos');

  const ciclo = await chamarFerramenta(c, 'refazer_ciclo', { minutos_por_volta: 120 });
  assert.ok(ciclo.dados.voltas.every((v) => v.minutos <= 120));
  const nivel = await chamarFerramenta(c, 'ajustar_conhecimento', { materia: 'Lógica', nivel: 'nao_conheco' });
  assert.ok(nivel.dados.blocos_no_ciclo > 0);
  const plano = await chamarFerramenta(c, 'ver_plano');
  assert.ok(plano.dados.materias.find((m) => m.nome === 'Lógica').peso_no_ciclo_pct > 33);

  await chamarFerramenta(c, 'definir_data_prova', { data: '2027-03-14' });
  assert.equal((await chamarFerramenta(c, 'ver_plano')).dados.plano.data_prova, '2027-03-14');

  const novo = await chamarFerramenta(c, 'criar_plano', { nome: 'Residência', edital_markdown: '## Clínica Médica\n- Cardiologia\n## Pediatria\n- Neonatologia' });
  const errado = await chamarFerramenta(c, 'apagar_plano', { plano_id: novo.dados.plano_id, confirmar_nome: 'residencia' });
  assert.ok(errado.erro && /exatamente/.test(errado.dados));
  const certo = await chamarFerramenta(c, 'apagar_plano', { plano_id: novo.dados.plano_id, confirmar_nome: 'Residência' });
  assert.equal(certo.dados.apagado, 'Residência');
  assert.equal((await chamarFerramenta(c, 'ver_plano')).dados.planos.length, 1);
});

test('Claude vê os materiais, marca a página, liga à matéria e relê a pasta', async (t) => {
  const caminho = bancoDeTeste();
  const raiz = mkdtempSync(join(tmpdir(), 'pdfs-'));
  mkdirSync(join(raiz, 'Portugues'));
  mkdirSync(join(raiz, 'Extras'));
  writeFileSync(join(raiz, 'Portugues', 'Aula 01.pdf'), '%PDF');
  writeFileSync(join(raiz, 'Extras', 'Bizu.pdf'), '%PDF');
  const c = conversar(caminho);
  t.after(() => c.fechar());

  assert.match((await chamarFerramenta(c, 'materiais')).dados.aviso, /Nenhuma pasta/);
  // A pasta só se escolhe pela tela do app; o Claude não consegue apontar para outro lugar.
  const recusado = await chamarFerramenta(c, 'atualizar_materiais', { pasta: raiz });
  assert.ok(recusado.erro);
  assert.match(recusado.dados, /tela Materiais/);
  const db = abrirBanco(caminho);
  db.prepare("INSERT INTO preferencia (chave, valor) VALUES ('pasta_materiais:1', ?)").run(JSON.stringify(raiz));
  db.close();
  const lido = await chamarFerramenta(c, 'atualizar_materiais', { pasta: tmpdir() });
  assert.deepEqual([lido.dados.pasta, lido.dados.total, lido.dados.novos], [raiz, 2, 2]);

  const porMateria = await chamarFerramenta(c, 'materiais', { materia: 'Português' });
  const [aula] = porMateria.dados.materiais;
  assert.equal(aula.nome, 'Aula 01');
  assert.equal(aula.caminho, join(raiz, 'Portugues', 'Aula 01.pdf'));

  await chamarFerramenta(c, 'marcar_pagina_material', { material_id: aula.id, pagina: 12 });
  const resumo = await chamarFerramenta(c, 'materiais');
  assert.equal(resumo.dados.abertos_por_ultimo[0].ultima_pagina, 12);
  assert.deepEqual(resumo.dados.por_materia.map((r) => r.materia), ['Português', '(sem matéria) Extras']);

  const [bizu] = (await chamarFerramenta(c, 'materiais', { materia: 'sem materia' })).dados.materiais;
  assert.equal((await chamarFerramenta(c, 'ligar_material', { material_id: bizu.id, materia: 'Lógica' })).dados.materia, 'Lógica');
  assert.equal((await chamarFerramenta(c, 'materiais', { materia: 'Lógica' })).dados.materiais.length, 1);
});

test('Claude cadastra fase, vê a virada, conta o bloco misturado e ajusta lotes, metas e preferências', async (t) => {
  const caminho = bancoDeTeste();
  const c = conversar(caminho);
  t.after(() => c.fechar());
  await c.pedir('initialize', { protocolVersion: '2025-06-18' });
  const hoje = s.dataLocal();
  const longe = (dias) => {
    const d = new Date();
    d.setDate(d.getDate() + dias);
    return s.dataLocal(d);
  };

  const sem = await chamarFerramenta(c, 'ver_fases');
  assert.equal(sem.dados.fases.length, 0);

  const misto = await chamarFerramenta(c, 'definir_fase', { nome: 'Errada', inicio: hoje, fim: longe(10), materias: [{ materia: 'Português', peso: 9 }] });
  assert.ok(misto.erro && /Faltou em: Lógica/.test(misto.dados));

  const def = await chamarFerramenta(c, 'definir_fase', {
    nome: 'Foco Português', inicio: longe(-5), fim: longe(10), minutos_por_volta: 180, questoes_misturadas_min: 30, teto_semanal_min: 600,
    materias: [{ materia: 'Português', peso: 3, grupo_foco: 'Crase' }, { materia: 'Lógica', peso: 1, tipo: 'revisao' }],
  });
  assert.equal(def.erro, undefined, def.dados);
  assert.equal(def.dados.ciclo_refeito, true);
  assert.deepEqual(def.dados.virada_de_fase, { de: null, para: 'Foco Português' });
  assert.ok(existsSync(join(caminho, '..', 'copias')));

  const sobreposta = await chamarFerramenta(c, 'definir_fase', { nome: 'Outra', inicio: longe(5), fim: longe(20) });
  assert.ok(sobreposta.erro && /sobrepõe/.test(sobreposta.dados));
  await chamarFerramenta(c, 'definir_fase', { nome: 'Depois', inicio: longe(11), fim: longe(40) });

  const plano = await chamarFerramenta(c, 'ver_plano');
  assert.equal(plano.dados.virada_de_fase, undefined, 'a segunda leitura não refaz');
  assert.equal(plano.dados.fase_ativa.nome, 'Foco Português');
  assert.equal(plano.dados.fase_ativa.dias_ate_o_fim, 10);
  assert.deepEqual(plano.dados.proxima_fase, { nome: 'Depois', comeca_em: longe(11), dias_ate_a_virada: 11 });
  assert.deepEqual(plano.dados.materias.map((m) => m.peso_no_ciclo_pct), [75, 25]);
  assert.deepEqual(plano.dados.semana, { modo: 'meta', teto_min: 600 });

  const fasesVistas = await chamarFerramenta(c, 'ver_fases');
  assert.deepEqual(fasesVistas.dados.fases.map((f) => [f.nome, f.ativa]), [['Foco Português', true], ['Depois', false]]);

  // Pula os blocos de conteúdo até chegar no misturado, que conta com estudo de questões de qualquer matéria.
  let proximo = await chamarFerramenta(c, 'proximo_estudo');
  assert.equal(proximo.dados.fase, 'Foco Português');
  assert.ok(['teoria', 'revisao'].includes(proximo.dados.proximo.tipo));
  for (let i = 0; i < 10 && proximo.dados.proximo.tipo !== 'questoes'; i++) {
    const m = proximo.dados.proximo.materia;
    await chamarFerramenta(c, 'registrar_estudo', { materia: m, tipo: proximo.dados.proximo.tipo, minutos: 10, conta_no_ciclo: true });
    proximo = await chamarFerramenta(c, 'proximo_estudo');
  }
  assert.equal(proximo.dados.proximo.materia, 'Questões misturadas (todas as matérias)');
  assert.equal(proximo.dados.proximo.minutos, 30);
  const teoria = await chamarFerramenta(c, 'registrar_estudo', { materia: 'Lógica', tipo: 'teoria', minutos: 30, conta_no_ciclo: true });
  assert.equal(teoria.dados.contou_no_ciclo, false);
  const quest = await chamarFerramenta(c, 'registrar_estudo', { materia: 'Lógica', tipo: 'questoes', minutos: 30, conta_no_ciclo: true });
  assert.equal(quest.dados.contou_no_ciclo, true);

  const refeito = await chamarFerramenta(c, 'refazer_ciclo', { minutos_por_volta: 240 });
  assert.match(refeito.dados.aviso, /define 180 min por volta/);

  const meta = await chamarFerramenta(c, 'definir_meta_acerto', { materia: 'portugues', meta_pct: 80 });
  assert.equal(meta.dados.meta_acerto_pct, 80);
  const pref = await chamarFerramenta(c, 'ajustar_preferencias', { intervalos_revisao: [30, 1, 7], modo_semana: 'teto', teto_semanal_min: 1200 });
  assert.deepEqual(pref.dados.intervalos_revisao, [1, 7, 30]);
  assert.equal(pref.dados.modo_semana, 'teto');
  assert.equal(pref.dados.teto_valendo_agora, 600, 'o teto da fase vale sobre o do plano');

  await chamarFerramenta(c, 'adicionar_questoes', {
    materia: 'Português', lote: 'Prova UEL 2025', questoes: [{ enunciado: 'x', alternativas: ['a', 'b'], correta: 0 }],
  });
  const reserva = await chamarFerramenta(c, 'reservar_lote', { lote: 'Prova UEL 2025', libera_em: '2027-09-01' });
  assert.deepEqual([reserva.dados.lote, reserva.dados.reservado], ['claude/Prova UEL 2025', true]);
  const depois = await chamarFerramenta(c, 'ver_plano');
  assert.deepEqual(depois.dados.lotes_reservados, [{ lote: 'claude/Prova UEL 2025', questoes: 1, libera_em: '2027-09-01' }]);
  assert.equal(depois.dados.materias[0].meta_acerto_pct, 80);

  const apagada = await chamarFerramenta(c, 'apagar_fase', { nome: 'Foco Português' });
  assert.equal(apagada.dados.ciclo_refeito, true);
  const semFase = await chamarFerramenta(c, 'proximo_estudo');
  assert.equal(semFase.dados.fase, null);
  assert.equal((await chamarFerramenta(c, 'ver_plano')).dados.ciclo.minutos_por_volta, 240, 'sem a fase, vale o tempo do plano');

  const sims = await chamarFerramenta(c, 'resultado_simulados');
  assert.deepEqual(sims.dados.simulados, []);
});

test('o servidor confere os números que o Claude manda, mesmo fora do esquema', async (t) => {
  const c = conversar(bancoDeTeste());
  t.after(() => c.fechar());
  await c.pedir('initialize', { protocolVersion: '2025-06-18' });
  const meta = await chamarFerramenta(c, 'definir_meta_acerto', { materia: 'Português', meta_pct: '<img src=x onerror=alert(1)>' });
  assert.ok(meta.erro && /percentual/.test(meta.dados));
  for (const ruim of [{ intervalos_revisao: 'abc' }, { intervalos_revisao: [0] }, { minutos_constancia: 'x' }, { modo_semana: 'outro' }, { teto_semanal_min: -5 }]) {
    const r = await chamarFerramenta(c, 'ajustar_preferencias', ruim);
    assert.ok(r.erro, JSON.stringify(ruim));
  }
  const plano = await chamarFerramenta(c, 'ver_plano');
  assert.equal(plano.dados.materias[0].meta_acerto_pct, null);
  assert.equal(plano.dados.semana.modo, 'meta');
});
