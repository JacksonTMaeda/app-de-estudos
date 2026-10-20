#!/usr/bin/env node
// Servidor MCP do App De Estudos: deixa o Claude consultar e mexer no app ao vivo.
// Lê, grava e apaga (decisão de projeto: total liberdade). Antes de cada operação que apaga
// ou refaz algo, guarda uma cópia do banco em <pasta do banco>/copias (as 30 mais novas, junto com as cópias de abertura).
// Fala o protocolo MCP direto (JSON-RPC, uma mensagem por linha no stdin/stdout); stdout é só do protocolo,
// qualquer aviso vai para o stderr.
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { abrirBanco, CAMINHO_PADRAO, copiarBanco as copiarBancoEm } from './db.js';
import { calcularPesos, gerarCiclo, OPCOES_PADRAO, opcoesDoCiclo, sincronizarFase } from './ciclo.js';
import * as fases from './fases.js';
import { listarSimulados } from './simulado.js';
import { importarEdital } from './edital.js';
import * as servico from './servico.js';
import * as questoes from './questoes.js';
import { analisarQuestoes } from './analise.js';
import * as materiais from './materiais.js';

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
  materiais.prepararMateriais(db);
  return db;
}

const copiarBanco = (motivo) => copiarBancoEm(banco(), CAMINHO, motivo);

// Virada de fase: o servidor MCP também refaz o ciclo quando a fase muda, porque a pessoa pode usar só o Claude.
const emDia = (plano) => sincronizarFase(banco(), plano.id, { copiar: copiarBanco });
const comVirada = (virada, resposta) => (virada ? { ...resposta, virada_de_fase: virada } : resposta);

const diasEntre = (de, ate) => {
  const [a1, m1, d1] = de.split('-').map(Number);
  const [a2, m2, d2] = ate.split('-').map(Number);
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86400000);
};

// Pesos do ciclo como o ciclo atual os calcula: com fase ativa, peso manual e matérias fora (peso 0).
function pesosDoCiclo(planoId, materias) {
  const fase = fases.faseAtiva(banco(), planoId);
  if (!fase) return new Map(calcularPesos(materias).map((m) => [m.id, m.peso]));
  const config = new Map(fase.materias.map((c) => [c.materia_id, c]));
  const dentro = materias.filter((m) => !config.get(m.id)?.fora).map((m) => ({ ...m, pesoManual: config.get(m.id)?.peso ?? undefined }));
  const pesos = new Map(materias.map((m) => [m.id, 0]));
  for (const m of calcularPesos(dentro)) pesos.set(m.id, m.peso);
  return pesos;
}

function faseParaResposta(f) {
  return {
    nome: f.nome,
    inicio: f.inicio,
    fim: f.fim,
    minutos_por_volta: f.minutos_por_volta,
    teto_semanal_min: f.teto_semanal_min,
    questoes_misturadas_min: f.questoes_mistas_min,
    anotacao: f.anotacao,
    materias: f.materias?.map((m) => ({ materia: m.materia, peso: m.peso, tipo: m.tipo, fora: m.fora, grupo_foco: m.grupo_foco })),
  };
}

const NOME_MISTO = 'Questões misturadas (todas as matérias)';

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
      const virada = emDia(plano);
      const materias = servico.materiasComTopicos(banco(), plano.id);
      const pesos = pesosDoCiclo(plano.id, materias);
      const ciclo = servico.cicloDoPlano(banco(), plano.id);
      const ativa = fases.faseAtiva(banco(), plano.id);
      const proxima = fases.proximaFase(banco(), plano.id);
      const semana = fases.semanaDoPlano(banco(), plano.id);
      return comVirada(virada, {
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
          meta_acerto_pct: m.meta_acerto,
        })),
        fase_ativa: ativa && { nome: ativa.nome, inicio: ativa.inicio, fim: ativa.fim, dias_ate_o_fim: diasEntre(hoje(), ativa.fim) },
        proxima_fase: proxima && { nome: proxima.nome, comeca_em: proxima.inicio, dias_ate_a_virada: diasEntre(hoje(), proxima.inicio) },
        semana: { modo: semana.modo, teto_min: semana.teto },
        lotes_reservados: questoes.listarLotes(banco(), plano.id).filter((l) => l.reservado).map((l) => ({ lote: l.lote, questoes: l.questoes, libera_em: l.libera_em })),
      });
    },
  },

  proximo_estudo: {
    description: 'O que estudar agora pelo ciclo: o próximo bloco (matéria, minutos, assunto sugerido, tipo do bloco e fase) e os 3 seguintes.',
    inputSchema: { type: 'object', properties: { ...PLANO } },
    rodar({ plano_id }) {
      const plano = escolherPlano(plano_id);
      const virada = emDia(plano);
      const proximo = servico.proximoBloco(banco(), plano.id, { reiniciar: false });
      if (!proximo) return comVirada(virada, { plano: plano.nome, proximo: null, aviso: 'Plano sem ciclo montado.' });
      const ciclo = servico.cicloDoPlano(banco(), plano.id);
      const i = ciclo.blocos.findIndex((b) => b.id === proximo.id);
      const seguintes = [1, 2, 3].map((k) => ciclo.blocos[(i + k) % ciclo.blocos.length]);
      return comVirada(virada, {
        plano: plano.nome,
        proximo: {
          materia: proximo.materia ?? NOME_MISTO,
          minutos: proximo.duracao_min,
          volta: proximo.volta,
          assunto_sugerido: proximo.misto
            ? 'questões de todas as matérias, embaralhadas, sem os lotes reservados'
            : proximo.topico?.nome ?? 'todos os assuntos concluídos',
          tipo: proximo.tipo,
          grupo_de_foco: proximo.grupo_foco,
        },
        fase: proximo.fase,
        progresso_do_ciclo: `${proximo.progresso.feitos} de ${proximo.progresso.total} blocos feitos`,
        depois: seguintes.map((b) => ({ materia: b.materia ?? NOME_MISTO, minutos: b.duracao_min, tipo: b.tipo })),
      });
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
      'Lança um estudo no app (aparece no histórico marcado como feito pelo Claude e agenda as revisões). Com conta_no_ciclo, marca como feito o próximo bloco do ciclo se for da mesma matéria (ou, se o próximo for o bloco de questões misturadas, se o estudo for do tipo questoes).',
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
      if (args.conta_no_ciclo) emDia(plano);
      const proximo = args.conta_no_ciclo ? servico.proximoBloco(banco(), plano.id) : null;
      const bate = proximo && (proximo.misto ? dados.tipo === 'questoes' : proximo.materia_id === dados.materia_id);
      if (bate) dados.bloco_id = proximo.id;
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
      const { blocos } = gerarCiclo(banco(), plano.id, opcoesDoCiclo(banco(), plano.id));
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
      const atual = { ...OPCOES_PADRAO, ...opcoesDoCiclo(banco(), plano.id) };
      const opcoes = {
        total: args.minutos_por_volta ?? atual.total,
        min: args.bloco_min ?? atual.min,
        max: args.bloco_max ?? atual.max,
        passo: args.passo ?? atual.passo,
      };
      const copia = copiarBanco('antes de refazer ciclo');
      const { blocos, fase, opcoes: usadas } = gerarCiclo(banco(), plano.id, opcoes);
      const voltas = [...new Set(blocos.map((b) => b.volta))].map((v) => ({
        volta: v,
        minutos: blocos.filter((b) => b.volta === v).reduce((a, b) => a + b.duracao, 0),
      }));
      const resposta = { opcoes, blocos: blocos.length, voltas, copia_do_banco: copia };
      if (fase && usadas.total !== opcoes.total) {
        resposta.aviso = `A fase "${fase}" define ${usadas.total} min por volta e vale até acabar; os ${opcoes.total} min ficam guardados como o tempo do plano para depois dela.`;
      }
      return resposta;
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

  materiais: {
    description:
      'PDFs de estudo da pasta escolhida no app, com a página onde a pessoa parou em cada um. Sem matéria: resumo por matéria e os 10 abertos por último. ' +
      'Com matéria: a lista completa dela. Cada PDF traz o caminho no disco, para ler o trecho direto do arquivo; o app nunca altera o PDF.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PLANO,
        materia: { type: 'string', description: 'Nome ou parte do nome da matéria. Use "sem materia" para os PDFs não ligados a nenhuma.' },
      },
    },
    rodar({ plano_id, materia }) {
      const plano = escolherPlano(plano_id);
      const pasta = materiais.pastaDoPlano(banco(), plano.id);
      if (!pasta) return { plano: plano.nome, pasta: null, aviso: 'Nenhuma pasta de materiais escolhida. Escolha na tela Materiais do app ou com atualizar_materiais.' };
      const caminhos = new Map(banco().prepare('SELECT id, caminho FROM material WHERE plano_id = ?').all(plano.id).map((m) => [m.id, m.caminho]));
      const todos = materiais.listarMateriais(banco(), plano.id);
      const item = (m) => ({
        id: m.id,
        nome: m.nome,
        materia: m.materia ?? null,
        subpasta: m.pasta,
        caminho: caminhos.get(m.id),
        paginas: m.paginas,
        ultima_pagina: m.paginas || m.aberto_em ? m.ultima_pagina : null,
        lido_pct: m.paginas ? Math.round((m.ultima_pagina / m.paginas) * 100) : null,
        aberto_em: m.aberto_em,
      });
      if (materia != null) {
        const lista = normal(materia).startsWith('sem materia')
          ? todos.filter((m) => !m.materia_id)
          : todos.filter((m) => m.materia_id === materiaPorNome(plano.id, materia).id);
        return { plano: plano.nome, pasta, materiais: lista.map(item) };
      }
      const resumo = new Map();
      for (const m of todos) {
        const chave = m.materia ?? `(sem matéria) ${m.pasta.split(' / ')[0] || 'pasta principal'}`;
        const r = resumo.get(chave) ?? { materia: chave, pdfs: 0, abertos: 0 };
        r.pdfs++;
        if (m.aberto_em) r.abertos++;
        resumo.set(chave, r);
      }
      const recentes = todos.filter((m) => m.aberto_em).sort((a, b) => b.aberto_em.localeCompare(a.aberto_em)).slice(0, 10);
      return { plano: plano.nome, pasta, total: todos.length, por_materia: [...resumo.values()], abertos_por_ultimo: recentes.map(item) };
    },
  },

  marcar_pagina_material: {
    description: 'Grava a página onde a pessoa parou num PDF (por exemplo, quando ela conta que leu até tal página fora do app). O leitor do app abre nessa página.',
    inputSchema: {
      type: 'object',
      properties: { material_id: { type: 'integer' }, pagina: { type: 'integer', minimum: 1 } },
      required: ['material_id', 'pagina'],
    },
    escreve: true,
    rodar({ material_id, pagina }) {
      materiais.guardarPagina(banco(), material_id, pagina);
      const m = materiais.obterMaterial(banco(), material_id);
      return { material: m.nome, ultima_pagina: m.ultima_pagina, paginas: m.paginas };
    },
  },

  ligar_material: {
    description: 'Liga um PDF a uma matéria do plano (ou desliga, com materia vazia). Serve para os PDFs cuja subpasta não tem o nome de nenhuma matéria.',
    inputSchema: {
      type: 'object',
      properties: { material_id: { type: 'integer' }, materia: { type: 'string', description: 'Nome ou parte do nome; vazio para tirar a matéria.' } },
      required: ['material_id'],
    },
    escreve: true,
    rodar({ material_id, materia }) {
      const m = materiais.obterMaterial(banco(), material_id);
      const alvo = materia ? materiaPorNome(m.plano_id, materia) : null;
      materiais.associarMateria(banco(), material_id, alvo?.id ?? null);
      return { material: m.nome, materia: alvo?.nome ?? null };
    },
  },

  atualizar_materiais: {
    description:
      'Lê de novo a pasta de materiais do plano: PDFs novos entram (ligados à matéria pelo nome da subpasta), os que saíram da pasta saem da lista. ' +
      'Os PDFs nunca são tocados; só a lista do app muda. A pasta em si só se escolhe ou troca pela tela Materiais do app.',
    inputSchema: { type: 'object', properties: { ...PLANO } },
    escreve: true,
    rodar({ plano_id }) {
      const plano = escolherPlano(plano_id);
      const pasta = materiais.pastaDoPlano(banco(), plano.id);
      if (!pasta) throw new Error('Este plano ainda não tem pasta de materiais. A pessoa escolhe a pasta na tela Materiais do app.');
      return { plano: plano.nome, ...materiais.escanearPasta(banco(), plano.id, pasta) };
    },
  },
});

// ---------- fases, lotes, metas e preferências (1.1) ----------
const MATERIA_DA_FASE = {
  type: 'object',
  properties: {
    materia: { type: 'string', description: 'Nome ou parte do nome da matéria' },
    peso: { type: 'number', exclusiveMinimum: 0, description: 'Peso manual (ex.: 9 e 1 dão 90% e 10%). Se uma matéria ativa tiver peso, todas precisam ter.' },
    tipo: { type: 'string', enum: fases.TIPOS_BLOCO, description: 'Tipo dos blocos dessa matéria na fase (padrão teoria)' },
    fora: { type: 'boolean', description: 'true tira a matéria do ciclo durante a fase' },
    grupo_foco: { type: 'string', description: 'Grupo de assuntos em foco: o prefixo do nome antes de " / " (ex.: "Cirurgia pediátrica")' },
  },
  required: ['materia'],
};

// Fase mudou: se é a do ciclo, refaz (com cópia); senão, confere se a fase ativa mudou.
function refazerSeFor(plano, faseId) {
  const ciclo = banco().prepare('SELECT fase_id FROM ciclo WHERE plano_id = ?').get(plano.id);
  if (ciclo && ciclo.fase_id === faseId) {
    const copia = copiarBanco('antes de refazer ciclo');
    gerarCiclo(banco(), plano.id, opcoesDoCiclo(banco(), plano.id));
    return { ciclo_refeito: true, copia_do_banco: copia };
  }
  const virada = emDia(plano);
  return { ciclo_refeito: !!virada && !virada.erro, ...(virada ? { virada_de_fase: virada } : {}) };
}

Object.assign(FERRAMENTAS, {
  ver_fases: {
    description: 'As fases com data do plano, com a ativa marcada e a configuração de cada matéria (peso manual, tipo do bloco, fora da fase, grupo de foco).',
    inputSchema: { type: 'object', properties: { ...PLANO } },
    rodar({ plano_id }) {
      const plano = escolherPlano(plano_id);
      const virada = emDia(plano);
      const ativa = fases.faseAtiva(banco(), plano.id);
      const lista = fases.listarFases(banco(), plano.id);
      return comVirada(virada, {
        plano: plano.nome,
        hoje: hoje(),
        fases: lista.map((f) => ({ ...faseParaResposta(f), ativa: f.id === ativa?.id })),
        aviso: lista.length ? undefined : 'Plano sem fases: o ciclo segue o modelo normal do Estudei.',
      });
    },
  },

  definir_fase: {
    description:
      'Cria ou atualiza uma fase pelo nome: período, minutos por volta, teto semanal, minutos de questões misturadas por volta e a configuração das matérias. ' +
      'Campo não enviado mantém o valor anterior; "materias", quando enviada, substitui a configuração inteira (matéria fora da lista volta ao padrão). ' +
      'Fases do mesmo plano não podem se sobrepor. Se a fase é a do ciclo atual, o ciclo é refeito (com cópia do banco antes).',
    inputSchema: {
      type: 'object',
      properties: {
        ...PLANO,
        nome: { type: 'string' },
        inicio: DATA('Primeiro dia da fase'),
        fim: DATA('Último dia da fase, inclusive'),
        minutos_por_volta: { type: 'integer', minimum: 60, description: 'Minutos de conteúdo por volta (sem ele, vale o do plano)' },
        teto_semanal_min: { type: 'integer', minimum: 1, description: 'Teto de estudo da semana, em minutos' },
        questoes_misturadas_min: { type: 'integer', minimum: 1, description: 'Minutos de um bloco de questões de todas as matérias no fim de cada volta' },
        anotacao: { type: 'string' },
        materias: { type: 'array', items: MATERIA_DA_FASE },
      },
      required: ['nome'],
    },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      const dados = {
        nome: args.nome,
        inicio: args.inicio,
        fim: args.fim,
        minutos_por_volta: args.minutos_por_volta,
        teto_semanal_min: args.teto_semanal_min,
        questoes_mistas_min: args.questoes_misturadas_min,
        anotacao: args.anotacao,
      };
      if (args.materias !== undefined) {
        dados.materias = args.materias.map((m) => ({ ...m, materia_id: materiaPorNome(plano.id, m.materia).id }));
      }
      const fase = fases.definirFase(banco(), plano.id, dados);
      return { fase: faseParaResposta(fase), ...refazerSeFor(plano, fase.id) };
    },
  },

  apagar_fase: {
    description: 'Apaga uma fase pelo nome. Se era a fase do ciclo, o ciclo é refeito sem ela. Guarda uma cópia do banco antes.',
    inputSchema: { type: 'object', properties: { ...PLANO, nome: { type: 'string' } }, required: ['nome'] },
    escreve: true,
    apaga: true,
    rodar({ plano_id, nome }) {
      const plano = escolherPlano(plano_id);
      const copia = copiarBanco('antes de apagar fase');
      const fase = fases.apagarFase(banco(), plano.id, nome);
      const virada = sincronizarFase(banco(), plano.id);
      return { apagada: fase.nome, copia_do_banco: copia, ciclo_refeito: !!virada && !virada.erro };
    },
  },

  lotes_de_questoes: {
    description: 'Os lotes do banco de questões (o nome que agrupa as questões, como "Prova UEL 2025"), com quantas questões e se estão reservados.',
    inputSchema: { type: 'object', properties: { ...PLANO } },
    rodar({ plano_id }) {
      const plano = escolherPlano(plano_id);
      return { plano: plano.nome, lotes: questoes.listarLotes(banco(), plano.id) };
    },
  },

  reservar_lote: {
    description:
      'Reserva um lote de questões (fica fora das rodadas comuns e do bloco misturado, e só aparece quando pedido, como num simulado) ou libera. ' +
      'Com libera_em, volta ao normal sozinho nessa data.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PLANO,
        lote: { type: 'string', description: 'Nome do lote (veja lotes_de_questoes)' },
        reservado: { type: 'boolean', description: 'false libera agora (padrão true)' },
        libera_em: DATA('Dia em que o lote volta ao normal (opcional)'),
      },
      required: ['lote'],
    },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      return questoes.reservarLote(banco(), plano.id, args.lote, { reservado: args.reservado ?? true, liberaEm: args.libera_em });
    },
  },

  definir_meta_acerto: {
    description: 'Grava a meta de acerto em questões de uma matéria (percentual), ou limpa sem meta_pct. Aparece no Edital, na Análise e em ver_plano.',
    inputSchema: {
      type: 'object',
      properties: { ...PLANO, materia: ESTUDO.materia, meta_pct: { type: 'number', minimum: 1, maximum: 100 } },
      required: ['materia'],
    },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      const m = materiaPorNome(plano.id, args.materia);
      banco().prepare('UPDATE materia SET meta_acerto = ? WHERE id = ?').run(args.meta_pct ?? null, m.id);
      return { materia: m.nome, meta_acerto_pct: args.meta_pct ?? null };
    },
  },

  ajustar_preferencias: {
    description:
      'Ajusta preferências sem abrir o banco: intervalos da revisão espaçada (dias, valem para todos os planos), minutos para o dia contar na constância, ' +
      'modo da semana do plano ("meta": o tempo por volta é a meta; "teto": é limite e a tela não mostra falta como atraso) e o teto semanal do plano em minutos ' +
      '(0 limpa; o teto da fase ativa vale sobre este). Só os campos enviados mudam.',
    inputSchema: {
      type: 'object',
      properties: {
        ...PLANO,
        intervalos_revisao: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, description: 'Ex.: [1, 7, 30]' },
        minutos_constancia: { type: 'integer', minimum: 1 },
        modo_semana: { type: 'string', enum: ['meta', 'teto'] },
        teto_semanal_min: { type: 'integer', minimum: 0 },
      },
    },
    escreve: true,
    rodar(args) {
      const plano = escolherPlano(args.plano_id);
      const gravar = banco().prepare('INSERT INTO preferencia (chave, valor) VALUES (?, ?) ON CONFLICT (chave) DO UPDATE SET valor = excluded.valor');
      if (args.intervalos_revisao) gravar.run('intervalos_revisao', JSON.stringify([...new Set(args.intervalos_revisao.map(Math.round))].sort((a, b) => a - b)));
      if (args.minutos_constancia) gravar.run('minutos_constancia', JSON.stringify(Math.round(args.minutos_constancia)));
      if (args.modo_semana) banco().prepare('UPDATE plano SET modo_semana = ? WHERE id = ?').run(args.modo_semana, plano.id);
      if (args.teto_semanal_min !== undefined) banco().prepare('UPDATE plano SET teto_semanal_min = ? WHERE id = ?').run(args.teto_semanal_min || null, plano.id);
      const pref = (chave) => JSON.parse(banco().prepare('SELECT valor FROM preferencia WHERE chave = ?').get(chave).valor);
      const p = banco().prepare('SELECT modo_semana, teto_semanal_min FROM plano WHERE id = ?').get(plano.id);
      return {
        intervalos_revisao: pref('intervalos_revisao'),
        minutos_constancia: pref('minutos_constancia'),
        modo_semana: p.modo_semana,
        teto_semanal_min: p.teto_semanal_min,
        teto_valendo_agora: fases.semanaDoPlano(banco(), plano.id).teto,
        aviso: args.intervalos_revisao ? 'Os intervalos novos valem para os estudos registrados daqui em diante.' : undefined,
      };
    },
  },

  resultado_simulados: {
    description: 'Os simulados feitos na tela de Questões do app: data, tempo, acerto geral e por matéria.',
    inputSchema: { type: 'object', properties: { ...PLANO, limite: { type: 'integer', minimum: 1, maximum: 100 } } },
    rodar({ plano_id, limite }) {
      const plano = escolherPlano(plano_id);
      return {
        plano: plano.nome,
        simulados: listarSimulados(banco(), plano.id, limite || 10).map((s) => ({
          quando: s.feito_em,
          minutos: s.minutos,
          questoes: s.questoes,
          acertos: s.acertos,
          acerto_pct: Math.round((s.acertos / s.questoes) * 100),
          lote: s.lote,
          por_materia: s.por_materia.map((m) => ({ materia: m.materia, questoes: m.questoes, acertos: m.acertos, em_branco: m.em_branco })),
        })),
      };
    },
  },
});

const INSTRUCOES =
  'Dados do App De Estudos, o programa de estudo que roda neste PC (ciclo, registro de estudo, revisões, banco de questões e materiais em PDF). ' +
  'Um plano pode ter fases com data (ver_fases, definir_fase): a fase ativa muda os pesos, o tipo dos blocos (teoria, revisão, questões), ' +
  'as matérias do ciclo e o assunto sugerido; na virada de fase o ciclo é refeito sozinho. Plano sem fase segue o ciclo normal. ' +
  'No modo teto o tempo da semana é limite, não obrigação: nunca apresente o que faltou como atraso. ' +
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
