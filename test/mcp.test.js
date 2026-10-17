import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
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
