#!/usr/bin/env node
// Servidor MCP do App De Estudos: deixa o Claude consultar e mexer no app ao vivo.
// Lê, grava e apaga (decisão de projeto: total liberdade). Antes de cada operação que apaga
// ou refaz algo, guarda uma cópia do banco em <pasta do banco>/copias (as 30 mais novas, junto com as cópias de abertura).
// Fala o protocolo MCP direto (JSON-RPC, uma mensagem por linha no stdin/stdout); stdout é só do protocolo,
// qualquer aviso vai para o stderr.
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { abrirBanco, CAMINHO_PADRAO, copiarBanco as copiarBancoEm } from './db.js';
import { calcularPesos, gerarCiclo, OPCOES_PADRAO } from './ciclo.js';
import { importarEdital } from './edital.js';
import * as servico from './servico.js';
import * as questoes from './questoes.js';
import { analisarQuestoes } from './analise.js';

const VERSAO = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PROTOCOLOS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const CAMINHO = process.env.ESTUDOS_DB || CAMINHO_PADRAO;
const CONHECIMENTO = { 0.5: 'Não conheço', 1.5: 'Conheço pouco', 2.5: 'Mediano', 3.5: 'Conheço bem', 4.5: 'Domino' };
const NIVEIS = { nao_conheco: 0.5, conheco_pouco: 1.5, mediano: 2.5, conheco_bem: 3.5, domino: 4.5 };

let db = null;
function banco() {
  if (db) return db;
  if (!existsSync(CAMINHO)) throw new Error(`Banco do app não encontrado em ${CAMINHO}. Abra o App De Estudos uma vez e importe o edital.`);
  db = abrirBanco(CAMINHO);
  questoes.prepararQuestoes(db);
  return db;
}

const copiarBanco = (motivo) => copiarBancoEm(banco(), CAMINHO, motivo);

const normal = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function materiaPorNome(planoId, nome) {
  const materias = banco().prepare('SELECT id, nome FROM materia WHERE plano_id = ? ORDER BY posicao').all(planoId);
  const exata = materias.find((m) => normal(m.nome) === normal(nome));
  const parecidas = exata ? [exata] : materias.filter((m) => normal(m.nome).includes(normal(nome)));
  if (parecidas.length === 1) return parecidas[0];
  const lista = materias.map((m) => m.nome).join('; ');
  throw new Error(parecidas.length ? `"${nome}" serve para mais de uma matéria: ${parecidas.map((m) => m.nome).join('; ')}.` : `Matéria "${nome}" não encontrada. Matérias: ${lista}.`);
}

// Assunto pelo número no edital ou por parte do nome.
function assuntoDa(materiaId, ref) {
  const topicos = banco().prepare('SELECT id, numero, nome FROM topico WHERE materia_id = ? ORDER BY numero').all(materiaId);
  const porNumero = /^\d+$/.test(String(ref).trim()) && topicos.find((t) => t.numero === Number(ref));
  if (porNumero) return porNumero;
  const achados = topicos.filter((t) => normal(t.nome).includes(normal(ref)));
  if (achados.length === 1) return achados[0];
  throw new Error(achados.length ? `"${ref}" serve para mais de um assunto: ${achados.map((t) => `${t.numero}. ${t.nome}`).join('; ')}.` : `Assunto "${ref}" não encontrado nessa matéria.`);
}

function escolherPlano(planoId) {
  const planos = servico.listarPlanos(banco());
  if (planos.length === 0) throw new Error('Nenhum plano no app ainda. Importe um edital pela tela do programa.');
  if (planoId == null) return planos[0];
  const plano = planos.find((p) => p.id === Number(planoId));
  if (!plano) throw new Error(`Plano ${planoId} não existe. Planos: ${planos.map((p) => `${p.id} (${p.nome})`).join(', ')}.`);
  return plano;
}

const hoje = () => servico.dataLocal();
const somarDias = (data, dias) => {
  const [a, m, d] = data.split('-').map(Number);
  return servico.dataLocal(new Date(a, m - 1, d + dias));
};
const PLANO = { plano_id: { type: 'integer', description: 'Id do plano. Sem ele, usa o primeiro plano (o normal é haver um só).' } };
const DATA = (desc) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: `${desc} (YYYY-MM-DD)` });

const FERRAMENTAS = {
  ver_plano: {
    description:
      'Visão geral do plano de estudo: prova, matérias com peso no ciclo (%), nível de conhecimento, importância (questões na prova), assuntos concluídos, tempo estudado e acerto em questões por matéria.',
    inputSchema: { type: 'object', properties: { ...PLANO } },
    rodar({ plano_id }) {
      const plano = escolherPlano(plano_id);
      const materias = servico.materiasComTopicos(banco(), plano.id);
      const pesos = new Map(calcularPesos(materias).map((m) => [m.id, m.peso]));
      const ciclo = servico.cicloDoPlano(banco(), plano.id);
      return {
        plano,
        planos: servico.listarPlanos(banco()),
        ciclo: ciclo && {
          minutos_por_volta: ciclo.tempo_total_min,
          voltas: new Set(ciclo.blocos.map((b) => b.volta)).size,
          blocos: ciclo.blocos.length,
          blocos_feitos: ciclo.blocos.filter((b) => b.feito).length,
        },
        materias: materias.map((m) => ({
          id: m.id,
          nome: m.nome,
          peso_no_ciclo_pct: pesos.get(m.id),
          conhecimento: CONHECIMENTO[m.conhecimento] ?? m.conhecimento,
          importancia: m.importancia,
          assuntos: `${m.topicos.filter((t) => t.concluido).length} de ${m.topicos.length} concluídos`,
          minutos_estudados: m.minutos,
          questoes: { acertos: m.acertos, erros: m.erros },
        })),
      };
    },
  },

  proximo_estudo: {
    description: 'O que estudar agora pelo ciclo: o próximo bloco (matéria, minutos, assunto sugerido) e os 3 seguintes.',
    inputSchema: { type: 'object', properties: { ...PLANO } },
    rodar({ plano_id }) {
      const plano = escolherPlano(plano_id);
      const proximo = servico.proximoBloco(banco(), plano.id, { reiniciar: false });
      if (!proximo) return { plano: plano.nome, proximo: null, aviso: 'Plano sem ciclo montado.' };
      const ciclo = servico.cicloDoPlano(banco(), plano.id);
      const i = ciclo.blocos.findIndex((b) => b.id === proximo.id);
      const seguintes = [1, 2, 3].map((k) => ciclo.blocos[(i + k) % ciclo.blocos.length]);
      return {
        plano: plano.nome,
        proximo: {
          materia: proximo.materia,
          minutos: proximo.duracao_min,
          volta: proximo.volta,
          assunto_sugerido: proximo.topico?.nome ?? 'todos os assuntos concluídos',
        },
        progresso_do_ciclo: `${proximo.progresso.feitos} de ${proximo.progresso.total} blocos feitos`,
        depois: seguintes.map((b) => ({ materia: b.materia, minutos: b.duracao_min })),
      };
    },
  },

  resumo_periodo: {
    description:
      'Quanto foi estudado entre duas datas: minutos por dia, por matéria e por tipo (teoria, questões, revisão), questões e dias que contaram para a constância. Sem datas, os últimos 7 dias.',
    inputSchema: {
      type: 'object',
      properties: { ...PLANO, inicio: DATA('Primeiro dia'), fim: DATA('Último dia, inclusive') },
    },
    rodar({ plano_id, inicio, fim }) {
      const plano = escolherPlano(plano_id);
      const ate = fim || hoje();
      return { plano: plano.nome, ...servico.resumoPeriodo(banco(), plano.id, inicio || somarDias(ate, -6), ate) };
    },
  },

  revisoes_pendentes: {
    description: 'Revisões espaçadas que vencem até a data (padrão: hoje), incluindo as atrasadas.',
    inputSchema: { type: 'object', properties: { ...PLANO, ate: DATA('Data limite') } },
    rodar({ plano_id, ate }) {
      const plano = escolherPlano(plano_id);
      const lista = servico.revisoesDoDia(banco(), plano.id, ate || hoje());
      return {
        plano: plano.nome,
        total: lista.length,
        revisoes: lista.map((r) => ({
          id: r.id,
          materia: r.materia,
          assunto: r.topico,
          estudado_em: r.inicio.slice(0, 10),
          prevista_para: r.data_prevista,
          atrasada: r.data_prevista < hoje(),
        })),
      };
    },
  },

  historico_sessoes: {
    description: 'Os últimos estudos registrados, com tempo, tipo, questões e a anotação de cada um.',
    inputSchema: {
      type: 'object',
      properties: { ...PLANO, limite: { type: 'integer', minimum: 1, maximum: 200, description: 'Quantos (padrão 20)' } },
    },
    rodar({ plano_id, limite }) {
      const plano = escolherPlano(plano_id);
      return {
        plano: plano.nome,
        sessoes: servico.historico(banco(), plano.id, limite || 20).map((s) => ({
          id: s.id,
          quando: s.inicio,
          materia: s.materia,
          assunto: s.topico,
          tipo: s.tipo,
          minutos: s.duracao_min,
          acertos: s.acertos,
          erros: s.erros,
          anotacao: s.anotacao,
          registrado_por: s.origem,
        })),
      };
    },
  },

  analise_questoes: {
    description:
      'Análise do banco de questões: acerto geral e por semana, por matéria, por banca e por tema, causas marcadas dos erros (não sabia o conteúdo, esqueceu número ou lista, leu errado, pressa, chute), tempo médio por questão e as questões erradas da última vez.',
    inputSchema: { type: 'object', properties: { ...PLANO } },
    rodar({ plano_id }) {
      const plano = escolherPlano(plano_id);
      const temBanco = banco().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'resposta'").get();
      if (!temBanco) return { plano: plano.nome, aviso: 'O banco de questões ainda não existe: abra o programa uma vez e importe os quizzes.' };
      return { plano: plano.nome, ...analisarQuestoes(banco(), plano.id) };
    },
  },

  assuntos_da_materia: {
    description: 'Os assuntos (tópicos do edital) de uma matéria, na ordem, com o que já foi concluído.',
    inputSchema: {
      type: 'object',
      properties: { ...PLANO, materia: { type: 'string', description: 'Nome ou parte do nome da matéria' } },
      required: ['materia'],
    },
    rodar({ plano_id, materia }) {
      const plano = escolherPlano(plano_id);
      const normal = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const materias = servico.materiasComTopicos(banco(), plano.id);
      const achada = materias.find((m) => normal(m.nome).includes(normal(materia)));
      if (!achada) throw new Error(`Matéria "${materia}" não encontrada. Matérias: ${materias.map((m) => m.nome).join('; ')}.`);
      return {
        materia: achada.nome,
        assuntos: achada.topicos.map((t) => ({ numero: t.numero, nome: t.nome, concluido: !!t.concluido })),
      };
    },
  },
};

// ---------- gravar e apagar ----------
const ESTUDO = {
  materia: { type: 'string', description: 'Nome ou parte do nome da matéria' },
  assunto: { type: 'string', description: 'Número do assunto no edital ou parte do nome (opcional)' },
  tipo: { type: 'string', enum: ['teoria', 'questoes', 'revisao'] },
  minutos: { type: 'integer', minimum: 0 },
  acertos: { type: 'integer', minimum: 0 },
  erros: { type: 'integer', minimum: 0 },
  anotacao: { type: 'string' },
  quando: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$', description: 'Data e hora local (YYYY-MM-DDTHH:MM). Sem ela, agora.' },
};

function dadosDoEstudo(planoId, args) {
  const dados = { tipo: args.tipo, duracao_min: args.minutos, acertos: args.acertos, erros: args.erros, anotacao: args.anotacao, inicio: args.quando };
  if (args.materia !== undefined) {
    const m = materiaPorNome(planoId, args.materia);
    dados.materia_id = m.id;
    dados.topico_id = args.assunto ? assuntoDa(m.id, args.assunto).id : null;
  }
  return dados;
}

const sessaoDoPlano = (planoId, id) => {
  const s = servico.obterSessao(banco(), Number(id));
  if (!s || s.plano_id !== planoId) throw new Error(`Estudo ${id} não existe nesse plano. Use historico_sessoes para ver os ids.`);
  return s;
};

Object.assign(FERRAMENTAS, {
  registrar_estudo: {
    description:
      'Lança um estudo no app (aparece no histórico marcado como feito pelo Claude e agenda as revisões). Com conta_no_ciclo, marca como feito o próximo bloco do ciclo se for da mesma matéria.',
    inputSchema: {
      type: 'object',
      properties: { ...PLANO, ...ESTUDO, concluiu_assunto: { type: 'boolean' }, conta_no_ciclo: { type: 'boolean' } },
      required: ['materia', 'tipo', 'minutos'],
    },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      const dados = dadosDoEstudo(plano.id, args);
      dados.topico_concluido = !!args.concluiu_assunto;
      const proximo = args.conta_no_ciclo ? servico.proximoBloco(banco(), plano.id) : null;
      if (proximo && proximo.materia_id === dados.materia_id) dados.bloco_id = proximo.id;
      const id = servico.registrarSessao(banco(), plano.id, dados, 'claude');
      return { registrado: servico.obterSessao(banco(), id), contou_no_ciclo: !!dados.bloco_id };
    },
  },

  corrigir_estudo: {
    description: 'Corrige um estudo já registrado (id de historico_sessoes). Só os campos enviados mudam; mudar a data move as revisões pendentes.',
    inputSchema: { type: 'object', properties: { ...PLANO, id: { type: 'integer' }, ...ESTUDO }, required: ['id'] },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      sessaoDoPlano(plano.id, args.id);
      const dados = Object.fromEntries(Object.entries(dadosDoEstudo(plano.id, args)).filter(([, v]) => v !== undefined));
      return { corrigido: servico.editarSessao(banco(), Number(args.id), dados) };
    },
  },

  apagar_estudo: {
    description: 'Apaga um estudo registrado e as revisões dele (id de historico_sessoes). Guarda uma cópia do banco antes.',
    inputSchema: { type: 'object', properties: { ...PLANO, id: { type: 'integer' } }, required: ['id'] },
    escreve: true,
    apaga: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      const s = sessaoDoPlano(plano.id, args.id);
      const copia = copiarBanco('antes de apagar estudo');
      servico.apagarSessao(banco(), s.id);
      return { apagado: s, copia_do_banco: copia };
    },
  },

  marcar_assunto: {
    description: 'Marca um assunto do edital como concluído (ou desmarca).',
    inputSchema: {
      type: 'object',
      properties: { ...PLANO, materia: ESTUDO.materia, assunto: { type: 'string', description: 'Número no edital ou parte do nome' }, concluido: { type: 'boolean' } },
      required: ['materia', 'assunto', 'concluido'],
    },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      const m = materiaPorNome(plano.id, args.materia);
      const t = assuntoDa(m.id, args.assunto);
      servico.alternarTopico(banco(), t.id, args.concluido);
      return { materia: m.nome, assunto: `${t.numero}. ${t.nome}`, concluido: args.concluido };
    },
  },

  concluir_revisao: {
    description: 'Marca uma revisão (id de revisoes_pendentes) como feita ou pulada.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, estado: { type: 'string', enum: ['feita', 'pulada'] } }, required: ['id', 'estado'] },
    escreve: true,
    rodar({ id, estado }) {
      servico.concluirRevisao(banco(), Number(id), estado);
      return { revisao: id, estado };
    },
  },

  ajustar_conhecimento: {
    description: 'Muda quanto a pessoa conhece uma matéria, o que refaz o ciclo (menos conhecimento, mais tempo). Guarda uma cópia do banco antes.',
    inputSchema: {
      type: 'object',
      properties: { ...PLANO, materia: ESTUDO.materia, nivel: { type: 'string', enum: Object.keys(NIVEIS) } },
      required: ['materia', 'nivel'],
    },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      const m = materiaPorNome(plano.id, args.materia);
      const copia = copiarBanco('antes de refazer ciclo');
      banco().prepare('UPDATE materia SET conhecimento = ? WHERE id = ?').run(NIVEIS[args.nivel], m.id);
      const c = banco().prepare('SELECT * FROM ciclo WHERE plano_id = ?').get(plano.id);
      const opcoes = c ? { total: c.tempo_total_min, min: c.bloco_min, max: c.bloco_max, passo: c.passo_min } : {};
      const { blocos } = gerarCiclo(banco(), plano.id, opcoes);
      return { materia: m.nome, nivel: args.nivel, blocos_no_ciclo: blocos.length, copia_do_banco: copia };
    },
  },

  refazer_ciclo: {
    description: 'Refaz o ciclo com outro tempo por volta ou outro tamanho de bloco. Recomeça a fila do zero. Guarda uma cópia do banco antes.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PLANO,
        minutos_por_volta: { type: 'integer', minimum: 60 },
        bloco_min: { type: 'integer', minimum: 15 },
        bloco_max: { type: 'integer', minimum: 15 },
        passo: { type: 'integer', minimum: 5 },
      },
    },
    escreve: true,
    apaga: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      const c = banco().prepare('SELECT * FROM ciclo WHERE plano_id = ?').get(plano.id);
      const atual = c ? { total: c.tempo_total_min, min: c.bloco_min, max: c.bloco_max, passo: c.passo_min } : OPCOES_PADRAO;
      const opcoes = {
        total: args.minutos_por_volta ?? atual.total,
        min: args.bloco_min ?? atual.min,
        max: args.bloco_max ?? atual.max,
        passo: args.passo ?? atual.passo,
      };
      const copia = copiarBanco('antes de refazer ciclo');
      const { blocos } = gerarCiclo(banco(), plano.id, opcoes);
      const voltas = [...new Set(blocos.map((b) => b.volta))].map((v) => ({
        volta: v,
        minutos: blocos.filter((b) => b.volta === v).reduce((a, b) => a + b.duracao, 0),
      }));
      return { opcoes, blocos: blocos.length, voltas, copia_do_banco: copia };
    },
  },

  definir_data_prova: {
    description: 'Grava (ou limpa, sem data) a data da prova do plano.',
    inputSchema: { type: 'object', properties: { ...PLANO, data: DATA('Data da prova') } },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      servico.definirDataProva(banco(), plano.id, args.data);
      return { plano: plano.nome, data_prova: args.data ?? null };
    },
  },

  adicionar_questoes: {
    description:
      'Acrescenta questões de múltipla escolha ao banco do app, numa matéria. Cada questão: enunciado, alternativas (lista), correta (índice começando em 0, ou letra), e opcionais fonte (ex.: "FGV / PC-MG / 2025"; para questão criada pelo Claude use "AUTORAL"), tema e comentario.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PLANO,
        materia: ESTUDO.materia,
        lote: { type: 'string', description: 'Nome do lote, como o de um quiz (ex.: "Claude 17-10-2026 Crase")' },
        questoes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              enunciado: { type: 'string' },
              alternativas: { type: 'array', items: { type: 'string' }, minItems: 2 },
              correta: { type: ['integer', 'string'] },
              fonte: { type: 'string' },
              tema: { type: 'string' },
              comentario: { type: 'string' },
            },
            required: ['enunciado', 'alternativas', 'correta'],
          },
        },
      },
      required: ['materia', 'lote', 'questoes'],
    },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      const m = materiaPorNome(plano.id, args.materia);
      const ids = questoes.adicionarQuestoes(banco(), plano.id, { origem: `claude/${args.lote}`, materiaId: m.id, questoes: args.questoes });
      return { materia: m.nome, adicionadas: ids.length, ids };
    },
  },

  apagar_questao: {
    description: 'Apaga uma questão do banco e as respostas dela (ids aparecem em analise_questoes). Guarda uma cópia do banco antes.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    escreve: true,
    apaga: true,
    rodar({ id }) {
      const q = banco().prepare('SELECT id, origem, numero, tema FROM questao WHERE id = ?').get(Number(id));
      if (!q) throw new Error(`Questão ${id} não existe.`);
      const copia = copiarBanco('antes de apagar questao');
      questoes.apagarQuestao(banco(), q.id);
      return { apagada: q, copia_do_banco: copia };
    },
  },

  criar_plano: {
    description:
      'Cria um plano novo a partir de um edital em markdown: cada título vira matéria, cada item de lista vira assunto; "(25)" no título vira o peso da matéria. Já monta o ciclo.',
    inputSchema: {
      type: 'object',
      properties: {
        nome: { type: 'string' },
        edital_markdown: { type: 'string' },
        data_prova: DATA('Data da prova (opcional)'),
        minutos_por_volta: { type: 'integer', minimum: 60 },
      },
      required: ['nome', 'edital_markdown'],
    },
    escreve: true,
    rodar(args) {
      const { planoId, materias } = importarEdital(banco(), { nomePlano: args.nome, dataProva: args.data_prova ?? null, markdown: args.edital_markdown });
      gerarCiclo(banco(), planoId, args.minutos_por_volta ? { total: args.minutos_por_volta } : {});
      return { plano_id: planoId, materias: materias.map((m) => ({ nome: m.nome, assuntos: m.topicos.length, importancia: m.importancia })) };
    },
  },

  apagar_plano: {
    description:
      'Apaga um plano inteiro: matérias, assuntos, ciclo, estudos, revisões e questões. Para evitar engano, exige o nome exato do plano em confirmar_nome. Guarda uma cópia do banco antes.',
    inputSchema: {
      type: 'object',
      properties: { plano_id: { type: 'integer' }, confirmar_nome: { type: 'string' } },
      required: ['plano_id', 'confirmar_nome'],
    },
    escreve: true,
    apaga: true,
    rodar({ plano_id, confirmar_nome }) {
      const plano = escolherPlano(plano_id);
      if (confirmar_nome !== plano.nome) throw new Error(`confirmar_nome precisa ser exatamente "${plano.nome}".`);
      const copia = copiarBanco('antes de apagar plano');
      servico.apagarPlano(banco(), plano.id);
      return { apagado: plano.nome, copia_do_banco: copia };
    },
  },
});

const INSTRUCOES =
  'Dados do App De Estudos, o programa de estudo que roda neste PC (ciclo, registro de estudo, revisões e banco de questões). ' +
  'Use para responder sobre o progresso real, orientar o que estudar e lançar ou corrigir o que a pessoa contar na conversa. ' +
  'As ferramentas gravam e apagam de verdade no app; as que apagam ou refazem guardam uma cópia do banco antes. ' +
  'Datas em YYYY-MM-DD e horários em hora local.';

function responder(id, resultado) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: resultado })}\n`);
}
function falhar(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

export function tratar(msg) {
  const { id, method, params = {} } = msg;
  const notificacao = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOLOS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLOS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'app-de-estudos', version: VERSAO },
        instructions: INSTRUCOES,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: Object.entries(FERRAMENTAS).map(([name, f]) => ({
          name,
          description: f.description,
          inputSchema: f.inputSchema,
          annotations: { readOnlyHint: !f.escreve, destructiveHint: !!f.apaga, openWorldHint: false },
        })),
      };
    case 'tools/call': {
      const ferramenta = FERRAMENTAS[params.name];
      if (!ferramenta) return { isError: true, content: [{ type: 'text', text: `Ferramenta desconhecida: ${params.name}` }] };
      try {
        const dados = ferramenta.rodar(params.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(dados, null, 1) }] };
      } catch (erro) {
        return { isError: true, content: [{ type: 'text', text: erro.message }] };
      }
    }
    default:
      if (notificacao) return undefined;
      throw Object.assign(new Error(`Método não suportado: ${method}`), { code: -32601 });
  }
}

const linhas = createInterface({ input: process.stdin });
linhas.on('line', (linha) => {
  if (!linha.trim()) return;
  let msg;
  try {
    msg = JSON.parse(linha);
  } catch {
    return falhar(null, -32700, 'JSON inválido');
  }
  const notificacao = msg.id === undefined || msg.id === null;
  try {
    const resultado = tratar(msg);
    if (!notificacao && resultado !== undefined) responder(msg.id, resultado);
  } catch (erro) {
    if (!notificacao) falhar(msg.id, erro.code ?? -32603, erro.message);
  }
});
linhas.on('close', () => {
  db?.close();
  process.exit(0);
});
