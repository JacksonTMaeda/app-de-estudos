// Telas do programa. Todo dado vem do processo principal por window.estudos.chamar.
import { abrirLeitor, fecharLeitor } from './leitor.js';

const chamar = (nome, ...args) => window.estudos.chamar(nome, ...args);
const $ = (sel) => document.querySelector(sel);

const PALETA = ['#4f5bd5', '#e0748c', '#2f9e6a', '#d9a21b', '#3aa0c8', '#9b6ad6', '#e08a3c', '#5c9e3a', '#c8508a', '#4a7fd1', '#b0893a', '#3cae9e', '#d65c5c', '#7a6ee0'];
const CONHECIMENTO = [
  [0.5, 'Não conheço'],
  [1.5, 'Conheço pouco'],
  [2.5, 'Mediano'],
  [3.5, 'Conheço bem'],
  [4.5, 'Domino'],
];
const TIPO = { teoria: 'Teoria', questoes: 'Questões', revisao: 'Revisão' };
const DIAS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];

const estado = { planoId: null, tela: 'inicio', materias: [], cores: new Map(), proximo: null };

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const horas = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min}min`);
const pct = (x) => `${Math.round(x * 100)}%`;
const cor = (materiaId, cadastrada) => cadastrada || estado.cores.get(materiaId) || PALETA[0];
const dataBR = (iso) => iso.slice(0, 10).split('-').reverse().join('-');
const hojeISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// Dias de hoje até a data (YYYY-MM-DD), contados no calendário local.
const diasAte = (iso) => {
  const [a, m, d] = iso.split('-').map(Number);
  const [ha, hm, hd] = hojeISO().split('-').map(Number);
  return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(ha, hm - 1, hd)) / 86400000);
};
const nomeLote = (lote) => lote.replace(/^claude\//, '');
const nomeMateria = (id) => estado.materias.find((m) => m.id === id)?.nome ?? 'Sem matéria';

// ---------- navegação ----------
document.querySelectorAll('nav button').forEach((b) =>
  b.addEventListener('click', () => mostrar(b.dataset.tela)),
);
function mostrar(tela) {
  if (estado.tela === 'leitor' && tela !== 'leitor') fecharLeitor();
  estado.tela = tela;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('ativo', b.dataset.tela === tela));
  document.querySelectorAll('.tela').forEach((s) => (s.hidden = s.id !== `tela-${tela}`));
  atualizar();
}

// ---------- carregar ----------
async function iniciar() {
  const agora = new Date();
  const h = agora.getHours();
  $('#saudacao').textContent = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  $('#data').textContent = agora.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#versao').textContent = `versão ${await chamar('versao')}`;
  await carregarPlanos();
}

async function carregarPlanos(escolher) {
  const planos = await chamar('planos');
  const sel = $('#plano');
  sel.innerHTML = planos.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join('');
  const temPlano = planos.length > 0;
  $('#vazio').hidden = temPlano;
  $('#adicionar').hidden = !temPlano;
  document.querySelectorAll('.tela').forEach((s) => s.hidden = !temPlano || s.id !== `tela-${estado.tela}`);
  if (!temPlano) return;
  const salvo = Number(localStorage.getItem('plano'));
  const existe = (id) => planos.some((p) => p.id === id);
  estado.planoId = existe(escolher) ? escolher : existe(salvo) ? salvo : planos[0].id;
  sel.value = estado.planoId;
  await atualizar();
}
$('#plano').addEventListener('change', (e) => {
  estado.planoId = Number(e.target.value);
  localStorage.setItem('plano', estado.planoId);
  atualizar();
});

async function importar() {
  const id = await chamar('importarEdital');
  if (id) await carregarPlanos(id);
}
$('#importar').addEventListener('click', importar);
document.querySelector('[data-acao=importar]').addEventListener('click', importar);

async function atualizar() {
  if (!estado.planoId) return;
  estado.materias = await chamar('materias', estado.planoId);
  estado.cores = new Map(estado.materias.map((m, i) => [m.id, m.cor || PALETA[i % PALETA.length]]));
  if (estado.tela === 'inicio') await telaInicio();
  if (estado.tela === 'ciclo') await telaCiclo();
  if (estado.tela === 'questoes') await telaQuestoes();
  if (estado.tela === 'analise') {
    await causas();
    await telaAnalise();
  }
  if (estado.tela === 'materiais') await telaMateriais();
  if (estado.tela === 'edital') telaEdital();
  if (estado.tela === 'historico') await telaHistorico();
}

// ---------- início ----------
async function telaInicio() {
  const [r, proximo, revisoes] = await Promise.all([
    chamar('resumo', estado.planoId),
    chamar('proximoBloco', estado.planoId),
    chamar('revisoes', estado.planoId),
  ]);
  estado.proximo = proximo;

  $('#n-hoje').textContent = horas(r.hoje);
  const barraSemana = $('#b-semana').parentElement;
  barraSemana.classList.remove('neutra', 'passou');
  if (r.modoSemana === 'teto') {
    // Teto é limite, não meta: sem cor nem texto de atraso; só avisa quando passa dele.
    const passou = r.tetoSemanal && r.semana > r.tetoSemanal;
    $('#n-semana').textContent = !r.tetoSemanal
      ? `Nesta semana: ${horas(r.semana)}`
      : passou
        ? `Nesta semana: ${horas(r.semana)}, acima do teto de ${horas(r.tetoSemanal)}`
        : `Nesta semana: ${horas(r.semana)} de até ${horas(r.tetoSemanal)}`;
    barraSemana.classList.add(passou ? 'passou' : 'neutra');
    $('#b-semana').style.width = r.tetoSemanal ? `${Math.min(100, (r.semana / r.tetoSemanal) * 100)}%` : '0';
  } else {
    $('#n-semana').textContent = r.metaSemanal
      ? `Nesta semana: ${horas(r.semana)} de ${horas(r.metaSemanal)}`
      : `Nesta semana: ${horas(r.semana)}`;
    $('#b-semana').style.width = r.metaSemanal ? `${Math.min(100, (r.semana / r.metaSemanal) * 100)}%` : '0';
  }

  const totalQ = r.questoes.acertos + r.questoes.erros;
  $('#n-desempenho').textContent = r.questoes.desempenho === null ? 'sem questões' : pct(r.questoes.desempenho);
  $('#n-desempenho').style.color = r.questoes.desempenho === null ? '' : r.questoes.desempenho >= 0.75 ? 'var(--bom)' : r.questoes.desempenho >= 0.65 ? 'var(--medio)' : 'var(--ruim)';
  $('#n-questoes').textContent = `${totalQ} questões no total; ${r.questoesSemana.acertos + r.questoesSemana.erros} nesta semana`;

  const ed = r.edital.total ? r.edital.feitos / r.edital.total : 0;
  $('#n-edital').textContent = pct(ed);
  $('#n-edital-det').textContent = `${r.edital.feitos} de ${r.edital.total} assuntos`;
  $('#b-edital').style.width = `${ed * 100}%`;

  desenharProximo(proximo);
  desenharRevisoes(revisoes);

  const maior = Math.max(60, ...r.semanaPorDia.map((d) => d.minutos));
  const hoje = r.constancia.at(-1).dia;
  $('#semana').innerHTML = r.semanaPorDia
    .map((d, i) => `<div class="col ${d.dia === hoje ? 'hoje' : ''}" title="${horas(d.minutos)}">
        <span>${d.minutos ? horas(d.minutos) : ''}</span>
        <div style="height:${(d.minutos / maior) * 100}%"></div>
        <span>${DIAS[i]}</span></div>`)
    .join('');
  $('#s-total').textContent = `${horas(r.semana)} na semana`;

  $('#constancia').innerHTML = r.constancia
    .map((d) => `<div class="${d.contou ? 'contou' : d.minutos ? 'pouco' : ''}" title="${dataBR(d.dia)}: ${horas(d.minutos)}"></div>`)
    .join('');
  $('#c-seguidos').textContent = `${r.diasSeguidos} ${r.diasSeguidos === 1 ? 'dia seguido' : 'dias seguidos'}`;
  $('#c-legenda').textContent = `Últimos 30 dias. O dia conta a partir de ${r.minimoConstancia} minutos de estudo.`;
}

function desenharProximo(p) {
  const alvo = $('#proximo');
  if (!p) {
    alvo.innerHTML = '<p class="sutil">Sem ciclo montado para este plano.</p>';
    $('#p-progresso').textContent = '';
    return;
  }
  $('#p-progresso').textContent = `${p.progresso.feitos} de ${p.progresso.total} blocos do ciclo`;
  const misto = p.materia_id == null;
  const tipo = p.fase || p.tipo !== 'teoria' ? ` · ${TIPO[p.tipo]}` : '';
  alvo.innerHTML = `<div class="proximo">
      <div class="faixa ${misto ? 'misto' : ''}" style="${misto ? '' : `background:${cor(p.materia_id, p.cor)}`}"></div>
      <div class="texto-proximo">
        <span class="etiqueta">Volta ${p.volta} · ${p.duracao_min} min${tipo}</span>
        <h3>${misto ? 'Questões misturadas' : esc(p.materia)}</h3>
        <p class="sutil">${misto ? 'Todas as matérias, embaralhadas, sem os lotes reservados' : p.topico ? esc(p.topico.nome) : 'Todos os assuntos concluídos'}</p>
      </div>
      <div class="acoes" ${cronometro.inicio ? 'hidden' : ''}>
        <button class="texto" id="pular">Pular</button>
        <button class="primario" id="iniciar">${misto ? '▶ Começar questões' : '▶ Iniciar estudo'}</button>
      </div>
    </div>`;
  $('#cronometro').hidden = !cronometro.inicio;
  $('#iniciar')?.addEventListener('click', () => (misto ? comecarMisto(p) : iniciarCronometro()));
  $('#pular')?.addEventListener('click', async () => {
    await chamar('pularBloco', p.id);
    atualizar();
  });
}

function desenharRevisoes(lista) {
  const alvo = $('#revisoes');
  if (lista.length === 0) {
    alvo.innerHTML = '<li><div class="meio"><div>Tudo em dia</div><div class="sutil">Nenhuma revisão para hoje.</div></div></li>';
    return;
  }
  alvo.innerHTML = lista
    .map((r) => `<li>
        <span class="bola" style="background:${cor(r.materia_id, r.cor)}"></span>
        <div class="meio"><div><strong>${esc(r.materia ?? 'Sem matéria')}</strong>${r.data_prevista < hojeISO() ? ' <span class="etiqueta">atrasada</span>' : ''}</div>
          <div class="sutil">${[r.topico && esc(r.topico), `estudado em ${dataBR(r.inicio)}`].filter(Boolean).join(' · ')}</div></div>
        <button class="secundario" data-rev="${r.id}" data-estado="feita">Feita</button>
        <button class="texto" data-rev="${r.id}" data-estado="pulada">Pular</button>
      </li>`)
    .join('');
  alvo.querySelectorAll('button[data-rev]').forEach((b) =>
    b.addEventListener('click', async () => {
      await chamar('concluirRevisao', Number(b.dataset.rev), b.dataset.estado);
      atualizar();
    }),
  );
}

// ---------- cronômetro ----------
// Guardado no localStorage para sobreviver a fechar e abrir o programa.
const cronometro = JSON.parse(localStorage.getItem('cronometro') || '{}');
let tique = null;

function salvarCronometro() {
  localStorage.setItem('cronometro', JSON.stringify(cronometro));
}
function segundosCorridos() {
  if (!cronometro.inicio) return 0;
  const ate = cronometro.pausadoEm || Date.now();
  return Math.floor((ate - cronometro.inicio - (cronometro.pausas || 0)) / 1000);
}
function desenharRelogio() {
  const s = segundosCorridos();
  const z = (n) => String(n).padStart(2, '0');
  $('#relogio').textContent = `${z(Math.floor(s / 3600))}:${z(Math.floor((s % 3600) / 60))}:${z(s % 60)}`;
  $('#pausar').textContent = cronometro.pausadoEm ? 'Continuar' : 'Pausar';
}
function ligarTique() {
  clearInterval(tique);
  if (cronometro.inicio) tique = setInterval(desenharRelogio, 1000);
  desenharRelogio();
}
function iniciarCronometro() {
  const p = estado.proximo;
  Object.assign(cronometro, {
    inicio: Date.now(),
    pausas: 0,
    pausadoEm: null,
    bloco_id: p?.id ?? null,
    materia_id: p?.materia_id ?? null,
    topico_id: p?.topico?.id ?? null,
    tipo: p?.tipo ?? 'teoria',
  });
  salvarCronometro();
  desenharProximo(p);
  ligarTique();
}
$('#pausar').addEventListener('click', () => {
  if (cronometro.pausadoEm) {
    cronometro.pausas += Date.now() - cronometro.pausadoEm;
    cronometro.pausadoEm = null;
  } else {
    cronometro.pausadoEm = Date.now();
  }
  salvarCronometro();
  desenharRelogio();
});
$('#descartar').addEventListener('click', () => {
  if (!confirm('Descartar este tempo sem registrar?')) return;
  pararCronometro();
});
$('#finalizar').addEventListener('click', () => {
  abrirRegistro({
    materia_id: cronometro.materia_id,
    topico_id: cronometro.topico_id,
    bloco_id: cronometro.bloco_id,
    tipo: cronometro.tipo,
    duracao_min: Math.max(1, Math.round(segundosCorridos() / 60)),
    inicioMs: cronometro.inicio,
    doCronometro: true,
  });
});
function pararCronometro() {
  for (const k of Object.keys(cronometro)) delete cronometro[k];
  salvarCronometro();
  clearInterval(tique);
  atualizar();
}

// ---------- registrar estudo ----------
const dialogo = $('#dialogo');
const form = $('#form');
let registroDoCronometro = false;

$('#adicionar').addEventListener('click', () => abrirRegistro({}));

function preencherTopicos(materiaId, topicoId) {
  const m = estado.materias.find((x) => x.id === Number(materiaId));
  const opcoes = (m?.topicos ?? []).map(
    (t) => `<option value="${t.id}" ${t.id === topicoId ? 'selected' : ''}>${t.concluido ? '✓ ' : ''}${t.numero}. ${esc(t.nome)}</option>`,
  );
  $('#f-topico').innerHTML = `<option value="">(nenhum)</option>${opcoes.join('')}`;
}
$('#f-materia').addEventListener('change', (e) => preencherTopicos(e.target.value));

// Data e hora local no formato do campo datetime-local (YYYY-MM-DDTHH:MM).
function dataHoraCampo(ms = Date.now()) {
  const d = new Date(ms);
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}

// Mesma janela para registrar (sem sessao_id) e para corrigir (com sessao_id).
function abrirRegistro(dados) {
  registroDoCronometro = !!dados.doCronometro;
  form.reset();
  const corrigindo = !!dados.sessao_id;
  $('#f-titulo').textContent = corrigindo ? 'Corrigir estudo' : 'Registrar estudo';
  $('#f-materia').innerHTML = estado.materias.map((m) => `<option value="${m.id}">${esc(m.nome)}</option>`).join('');
  const materiaId = dados.materia_id ?? estado.materias[0]?.id;
  $('#f-materia').value = materiaId;
  preencherTopicos(materiaId, dados.topico_id);
  form.tipo.value = dados.tipo ?? 'teoria';
  form.duracao_min.value = dados.duracao_min ?? '';
  form.inicio.value = dados.inicio ?? dataHoraCampo(dados.inicioMs);
  form.acertos.value = dados.acertos ?? 0;
  form.erros.value = dados.erros ?? 0;
  form.anotacao.value = dados.anotacao ?? '';
  form.bloco_id.value = dados.bloco_id ?? '';
  form.sessao_id.value = dados.sessao_id ?? '';
  dialogo.showModal();
}

dialogo.addEventListener('close', async () => {
  if (dialogo.returnValue !== 'salvar') return;
  const f = new FormData(form);
  const dados = {
    materia_id: Number(f.get('materia_id')) || null,
    topico_id: Number(f.get('topico_id')) || null,
    tipo: f.get('tipo'),
    inicio: f.get('inicio'),
    duracao_min: Number(f.get('duracao_min')),
    acertos: Number(f.get('acertos')),
    erros: Number(f.get('erros')),
    anotacao: f.get('anotacao').trim(),
    topico_concluido: f.get('topico_concluido') === 'on',
    bloco_id: Number(f.get('bloco_id')) || null,
  };
  const sessaoId = Number(f.get('sessao_id'));
  if (sessaoId) {
    await chamar('editarSessao', sessaoId, dados);
    if (dados.topico_concluido && dados.topico_id) await chamar('alternarTopico', dados.topico_id, true);
  } else {
    await chamar('registrarSessao', estado.planoId, dados);
  }
  if (registroDoCronometro) pararCronometro();
  else atualizar();
});

// ---------- ciclo ----------
const EXPLICA_CICLO = 'Matéria grande entra em toda volta; matéria pequena, em volta sim, volta não. O peso vem do número de questões e do quanto você já conhece a matéria (ajuste na aba Edital).';
const EXPLICA_FASE = 'Nesta fase, as matérias do ciclo, os pesos e o tipo de cada bloco seguem o que foi cadastrado para ela. Quando a fase muda, o ciclo é refeito sozinho e a fila recomeça.';

async function telaCiclo() {
  const [ciclo, fases] = await Promise.all([chamar('ciclo', estado.planoId), chamar('fases', estado.planoId)]);
  desenharFases(fases);
  if (!ciclo) {
    $('#ciclo').innerHTML = '<p class="sutil">Sem ciclo.</p>';
    return;
  }
  const atual = ciclo.blocos.find((b) => !b.feito)?.id;
  const voltas = [...new Set(ciclo.blocos.map((b) => b.volta))];
  const comTipo = !!ciclo.fase || ciclo.blocos.some((b) => b.tipo !== 'teoria' || b.misto);
  $('#ciclo-info').textContent = `${horas(ciclo.tempo_total_min)} por volta · blocos de ${ciclo.bloco_min} a ${ciclo.bloco_max} min`;
  const f = ciclo.fase;
  const prox = ciclo.proximaFase;
  $('#ciclo-fase').hidden = !f && !prox;
  $('#ciclo-fase').innerHTML = f
    ? `<strong>Fase: ${esc(f.nome)}</strong><span class="sutil">${dataBR(f.inicio)} a ${dataBR(f.fim)}</span>
       <span class="sutil">${prox ? `${diasAte(prox.inicio)} dias até a fase ${esc(prox.nome)}` : `última fase, termina daqui a ${diasAte(f.fim)} dias`}</span>`
    : prox ? `<span class="sutil">Sem fase agora. A fase ${esc(prox.nome)} começa em ${dataBR(prox.inicio)}, daqui a ${diasAte(prox.inicio)} dias.</span>` : '';
  $('#ciclo-explica').textContent = f ? EXPLICA_FASE : EXPLICA_CICLO;
  $('#ciclo').innerHTML = voltas
    .map((v) => {
      const blocos = ciclo.blocos.filter((b) => b.volta === v);
      const soma = blocos.reduce((a, b) => a + b.duracao_min, 0);
      return `<div class="volta"><h3>Volta ${v} de ${voltas.length} · ${horas(soma)}</h3><div class="blocos">${blocos
        .map((b) => `<div class="bloco ${b.feito ? 'feito' : ''} ${b.id === atual ? 'atual' : ''}">
            <span class="pos">${b.feito ? '✓' : b.posicao}</span>
            <span class="bola ${b.misto ? 'misto' : ''}" style="width:10px;height:10px;border-radius:50%;${b.misto ? '' : `background:${cor(b.materia_id, b.cor)}`}"></span>
            <span>${b.misto ? 'Questões misturadas' : esc(b.materia)}</span>
            ${comTipo ? `<span class="selo ${b.tipo}">${TIPO[b.tipo]}</span>` : ''}
            <span class="min">${b.duracao_min}'</span></div>`)
        .join('')}</div></div>`;
    })
    .join('');
}

// Fases cadastradas (pelo Claude, via MCP). Nesta versão a tela só mostra.
function desenharFases({ lista, ativa }) {
  $('#cartao-fases').hidden = lista.length === 0;
  $('#fases').innerHTML = lista
    .map((f) => {
      const detalhes = [
        f.minutos_por_volta && `${horas(f.minutos_por_volta)} por volta`,
        f.questoes_mistas_min && `${f.questoes_mistas_min} min de questões misturadas por volta`,
        f.teto_semanal_min && `teto de ${horas(f.teto_semanal_min)} por semana`,
        f.anotacao && esc(f.anotacao),
      ].filter(Boolean).join(' · ');
      const materias = f.materias
        .map((m) => {
          const partes = m.fora
            ? ['fora da fase']
            : [m.peso != null && `peso ${m.peso}`, m.tipo !== 'teoria' && TIPO[m.tipo], m.grupo_foco && `foco: ${esc(m.grupo_foco)}`].filter(Boolean);
          return `<span class="selo ${m.fora ? '' : m.tipo}">${esc(m.materia)}${partes.length ? `: ${partes.join(', ')}` : ''}</span>`;
        })
        .join('');
      return `<div class="fase ${f.id === ativa ? 'ativa' : ''}">
          <div class="cabeca"><h3>${esc(f.nome)} ${f.id === ativa ? '<span class="etiqueta">agora</span>' : ''}</h3>
            <span class="sutil">${dataBR(f.inicio)} a ${dataBR(f.fim)}</span></div>
          ${detalhes ? `<p class="sutil">${detalhes}</p>` : ''}
          <div class="conf">${materias}</div></div>`;
    })
    .join('');
}

// ---------- edital ----------
function telaEdital() {
  const abertos = new Set([...document.querySelectorAll('#edital details[open]')].map((d) => d.dataset.id));
  $('#edital').innerHTML = estado.materias
    .map((m) => {
      const feitos = m.topicos.filter((t) => t.concluido).length;
      const q = m.acertos + m.erros;
      return `<details class="cartao materia" data-id="${m.id}" ${abertos.has(String(m.id)) ? 'open' : ''}>
        <summary>
          <span class="bola" style="width:12px;height:12px;border-radius:50%;background:${cor(m.id, m.cor)}"></span>
          <span class="nome">${esc(m.nome)}</span>
          <span class="num">${horas(m.minutos)} estudados</span>
          <span class="num">${q ? `${pct(m.acertos / q)} em ${q} questões` : 'sem questões'}${m.meta_acerto
            ? `<br><span class="meta-acerto ${q && (m.acertos / q) * 100 >= m.meta_acerto ? 'batida' : ''}">meta ${m.meta_acerto}%</span>` : ''}</span>
          <span class="num">${feitos} de ${m.topicos.length} assuntos</span>
          <div class="barra mini"><div style="width:${m.topicos.length ? (feitos / m.topicos.length) * 100 : 0}%"></div></div>
        </summary>
        <div class="ajuste">Quanto você já conhece:
          <select data-materia="${m.id}">${CONHECIMENTO.map(([v, r]) => `<option value="${v}" ${v === m.conhecimento ? 'selected' : ''}>${r}</option>`).join('')}</select>
          <span class="sutil">Peso na prova: ${m.importancia} ${m.importancia === 2.5 ? '' : 'questões'}</span>
        </div>
        <div class="topicos">${m.topicos
          .map((t) => `<label class="${t.concluido ? 'feito' : ''}"><input type="checkbox" data-topico="${t.id}" ${t.concluido ? 'checked' : ''}><span>${t.numero}. ${esc(t.nome)}</span></label>`)
          .join('')}</div>
      </details>`;
    })
    .join('');
  $('#edital').querySelectorAll('input[data-topico]').forEach((c) =>
    c.addEventListener('change', async () => {
      await chamar('alternarTopico', Number(c.dataset.topico), c.checked);
      atualizar();
    }),
  );
  $('#edital').querySelectorAll('select[data-materia]').forEach((s) =>
    s.addEventListener('change', async () => {
      await chamar('ajustarConhecimento', estado.planoId, Number(s.dataset.materia), Number(s.value));
      atualizar();
    }),
  );
}

// ---------- questões ----------
const LETRAS = ['A', 'B', 'C', 'D', 'E', 'F'];
const rodada = { lista: [], i: 0, escolhida: null, respondida: false, respostas: [], inicio: 0 };

// O HTML das questões vem dos quizzes do cofre: tira script, estilo, iframe e atributos de evento.
function limparHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
    }
  });
  return doc.body.firstChild.innerHTML;
}

const ehBanca = (fonte) => fonte && !/autoral/i.test(fonte);

function filtrosDeQuestao() {
  return {
    materiaId: Number($('#q-materia').value) || null,
    origem: $('#q-origem').value,
    situacao: $('#q-situacao').value,
    lote: $('#q-lote').value || null,
    limite: 2000,
  };
}

async function telaQuestoes() {
  if (!$('#q-resolver').hidden || !$('#q-simulado').hidden) return; // não mexe numa rodada ou simulado em andamento
  const [resumo, bancas, lotes] = await Promise.all([
    chamar('resumoQuestoes', estado.planoId), chamar('bancas', estado.planoId), chamar('lotes', estado.planoId),
  ]);
  const mantem = (sel, html) => {
    const atual = sel.value;
    sel.innerHTML = html;
    if ([...sel.options].some((o) => o.value === atual)) sel.value = atual;
  };
  mantem($('#q-materia'), `<option value="">Todas as matérias</option>${estado.materias.map((m) => `<option value="${m.id}">${esc(m.nome)}</option>`).join('')}`);
  mantem($('#q-origem'), `<option value="todas">Banca e autorais</option><option value="banca">Só de banca</option><option value="autoral">Só autorais</option>${bancas.map((b) => `<option value="${esc(b.banca)}">${esc(b.banca)} (${b.total})</option>`).join('')}`);
  // Lote reservado (cadeado) fica fora das rodadas; só entra escolhendo o lote ou no simulado.
  const opcaoLote = (l) => `<option value="${esc(l.lote)}">${l.reservado ? '🔒 ' : ''}${esc(nomeLote(l.lote))} (${l.questoes})${
    l.reservado ? (l.libera_em ? `, libera em ${dataBR(l.libera_em)}` : ', reservado') : ''}</option>`;
  estado.haReservados = lotes.some((l) => l.reservado);
  mantem($('#q-lote'), `<option value="">${estado.haReservados ? 'Todos, sem os reservados' : 'Todos os lotes'}</option>${lotes.map(opcaoLote).join('')}`);
  mantem($('#s-lote'), `<option value="">Todos, sem os reservados</option>${estado.haReservados ? '<option value="*">Todos, com os reservados</option>' : ''}${lotes.map(opcaoLote).join('')}`);
  $('#q-resumo').innerHTML = resumo.length
    ? resumo.map((r) => `<tr><td>${esc(r.materia ?? 'Sem matéria')}</td><td>${r.total}</td><td>${r.respondidas}</td>
        <td>${r.respostas ? pct(r.acertos / r.respostas) : ''}</td></tr>`).join('')
    : '<tr><td colspan="4" class="sutil">Nenhuma questão ainda. Use "Importar quizzes do cofre" e escolha a pasta do concurso.</td></tr>';
  await contarDisponiveis();
}

async function contarDisponiveis() {
  const lista = await chamar('questoes', estado.planoId, filtrosDeQuestao());
  $('#q-disponiveis').textContent = `${lista.length} ${lista.length === 1 ? 'questão disponível' : 'questões disponíveis'} com esses filtros`;
  $('#q-comecar').disabled = lista.length === 0;
  return lista;
}
['#q-materia', '#q-origem', '#q-situacao', '#q-lote'].forEach((s) => $(s).addEventListener('change', contarDisponiveis));

$('#q-importar').addEventListener('click', async () => {
  const relatorio = await chamar('importarQuizzes', estado.planoId);
  if (!relatorio) return;
  const total = relatorio.reduce((a, r) => a + r.questoes, 0);
  const semMateria = relatorio.filter((r) => !r.materia).length;
  alert(`${total} questões importadas de ${relatorio.length} quizzes.${semMateria ? `\n${semMateria} quiz(zes) sem matéria reconhecida pelo nome da pasta.` : ''}`);
  telaQuestoes();
});

$('#q-comecar').addEventListener('click', async () => {
  let lista = await contarDisponiveis();
  if ($('#q-embaralhar').checked) {
    for (let i = lista.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lista[i], lista[j]] = [lista[j], lista[i]];
    }
  }
  iniciarRodada(lista.slice(0, Number($('#q-quantas').value)));
});

// blocoId: a rodada é o bloco de questões misturadas do ciclo; ao encerrar com resposta, o bloco conta como feito.
function iniciarRodada(lista, { blocoId = null } = {}) {
  Object.assign(rodada, { lista, i: 0, respostas: [], inicio: Date.now(), blocoId });
  $('#q-escolha').hidden = true;
  $('#q-fim').hidden = true;
  $('#q-resolver').hidden = false;
  mostrarQuestao();
}

function mostrarQuestao() {
  const q = rodada.lista[rodada.i];
  rodada.escolhida = null;
  rodada.respondida = false;
  rodada.abertaEm = Date.now();
  const acertos = rodada.respostas.filter((r) => r.acertou).length;
  $('#q-posicao').textContent = `Questão ${rodada.i + 1} de ${rodada.lista.length}`;
  $('#q-placar').textContent = rodada.respostas.length ? `${acertos} de ${rodada.respostas.length} certas` : '';
  $('#q-meta').innerHTML = [
    q.materia && `<span class="etiqueta">${esc(q.materia)}</span>`,
    q.fonte && `<span class="etiqueta ${ehBanca(q.fonte) ? 'banca' : ''}">${esc(ehBanca(q.fonte) ? q.fonte : 'Autoral')}</span>`,
    q.tema && `<span class="sutil">${esc(q.tema)}</span>`,
  ].filter(Boolean).join('');
  $('#q-enunciado').innerHTML = limparHtml(q.enunciado);
  $('#q-alternativas').innerHTML = q.alternativas
    .map((a, i) => `<button class="alt" data-i="${i}"><span class="letra">${LETRAS[i]}</span><span>${limparHtml(a)}</span></button>`)
    .join('');
  $('#q-alternativas').querySelectorAll('.alt').forEach((b) => b.addEventListener('click', () => escolher(Number(b.dataset.i))));
  $('#q-comentario').hidden = true;
  $('#q-acao').textContent = 'Responder';
  $('#q-acao').disabled = true;
  document.querySelector('main').scrollTop = 0;
}

function escolher(i) {
  if (rodada.respondida) return;
  rodada.escolhida = i;
  $('#q-alternativas').querySelectorAll('.alt').forEach((b) => b.classList.toggle('escolhida', Number(b.dataset.i) === i));
  $('#q-acao').disabled = false;
}

async function responder() {
  const q = rodada.lista[rodada.i];
  const segundos = (Date.now() - rodada.abertaEm) / 1000;
  const { respostaId, acertou, correta } = await chamar('responderQuestao', q.id, rodada.escolhida, segundos);
  rodada.respondida = true;
  rodada.respostas.push({ materia_id: q.materia_id, acertou });
  $('#q-alternativas').querySelectorAll('.alt').forEach((b) => {
    const i = Number(b.dataset.i);
    b.disabled = true;
    b.classList.remove('escolhida');
    if (i === correta) b.classList.add('certa');
    else if (i === rodada.escolhida) b.classList.add('errada');
  });
  $('#q-comentario').innerHTML = `<strong class="${acertou ? 'ok' : 'nao'}">${acertou ? 'Certa!' : `Errada. Gabarito: ${LETRAS[correta]}.`}</strong>
    ${q.comentario ? `<div>${limparHtml(q.comentario)}</div>` : ''}
    ${acertou ? '' : `<div class="causa"><span>Por que errou?</span>${Object.entries(await causas())
      .map(([k, rotulo]) => `<button data-causa="${k}">${esc(rotulo)}</button>`).join('')}</div>`}`;
  $('#q-comentario').querySelectorAll('[data-causa]').forEach((b) =>
    b.addEventListener('click', async () => {
      const desmarcar = b.classList.contains('marcada');
      await chamar('marcarCausa', respostaId, desmarcar ? null : b.dataset.causa);
      $('#q-comentario').querySelectorAll('[data-causa]').forEach((x) => x.classList.toggle('marcada', !desmarcar && x === b));
    }),
  );
  $('#q-comentario').hidden = false;
  $('#q-acao').textContent = rodada.i + 1 < rodada.lista.length ? 'Próxima' : 'Ver resultado';
  const acertos = rodada.respostas.filter((r) => r.acertou).length;
  $('#q-placar').textContent = `${acertos} de ${rodada.respostas.length} certas`;
}

$('#q-acao').addEventListener('click', () => {
  if (!rodada.respondida) return responder();
  if (rodada.i + 1 < rodada.lista.length) {
    rodada.i++;
    mostrarQuestao();
  } else encerrarRodada();
});
$('#q-encerrar').addEventListener('click', encerrarRodada);

// Teclado: A a E (ou 1 a 5) escolhe, Enter responde e avança.
document.addEventListener('keydown', (e) => {
  if (!$('#q-simulado').hidden && !dialogo.open && !e.ctrlKey && !e.altKey) {
    const k = 'abcdef'.indexOf(e.key.toLowerCase()) >= 0 ? 'abcdef'.indexOf(e.key.toLowerCase()) : '123456'.indexOf(e.key);
    if (k >= 0 && k < sim.lista[sim.i].alternativas.length) escolherSim(k);
    if (e.key === 'ArrowRight') irParaSim(sim.i + 1);
    if (e.key === 'ArrowLeft') irParaSim(sim.i - 1);
    return;
  }
  if ($('#q-resolver').hidden || dialogo.open || e.ctrlKey || e.altKey) return;
  const n = 'abcdef'.indexOf(e.key.toLowerCase()) >= 0 ? 'abcdef'.indexOf(e.key.toLowerCase()) : '123456'.indexOf(e.key);
  if (n >= 0 && n < rodada.lista[rodada.i].alternativas.length) escolher(n);
  if (e.key === 'Enter' && !$('#q-acao').disabled) $('#q-acao').click();
});

// Fecha a rodada e lança no histórico um estudo de questões por matéria, com o tempo dividido
// pela quantidade de questões de cada uma.
async function encerrarRodada() {
  const respostas = rodada.respostas;
  const minutos = Math.max(1, Math.round((Date.now() - rodada.inicio) / 60000));
  if (respostas.length) {
    const porMateria = new Map();
    for (const r of respostas) {
      const m = porMateria.get(r.materia_id) || { acertos: 0, erros: 0 };
      r.acertou ? m.acertos++ : m.erros++;
      porMateria.set(r.materia_id, m);
    }
    for (const [materia_id, m] of porMateria) {
      await chamar('registrarSessao', estado.planoId, {
        materia_id,
        tipo: 'questoes',
        duracao_min: Math.round((minutos * (m.acertos + m.erros)) / respostas.length),
        acertos: m.acertos,
        erros: m.erros,
        anotacao: `Banco de questões do app: ${m.acertos + m.erros} questões`,
      });
    }
    if (rodada.blocoId) await chamar('pularBloco', rodada.blocoId);
  }
  rodada.blocoId = null;
  const acertos = respostas.filter((r) => r.acertou).length;
  $('#q-resolver').hidden = true;
  $('#q-fim').hidden = false;
  $('#q-fim').innerHTML = respostas.length
    ? `<h2>Rodada encerrada</h2>
       <div class="fim-numero" style="color:${acertos / respostas.length >= 0.75 ? 'var(--bom)' : acertos / respostas.length >= 0.65 ? 'var(--medio)' : 'var(--ruim)'}">${pct(acertos / respostas.length)}</div>
       <p>${acertos} certas de ${respostas.length} em ${horas(minutos)}. Já está no histórico e no desempenho.</p>
       <div class="botoes"><button class="primario" id="q-voltar">Nova rodada</button></div>`
    : `<h2>Rodada encerrada</h2><p class="sutil">Nenhuma questão respondida, nada foi registrado.</p>
       <div class="botoes"><button class="primario" id="q-voltar">Voltar</button></div>`;
  $('#q-voltar').addEventListener('click', () => {
    $('#q-fim').hidden = true;
    $('#q-escolha').hidden = false;
    atualizar();
  });
}

// Bloco de questões misturadas: uma questão a cada 3 minutos do bloco, primeiro as nunca respondidas.
async function comecarMisto(p) {
  const n = Math.max(5, Math.round(p.duracao_min / 3));
  let lista = await chamar('questoes', estado.planoId, { situacao: 'nao_respondidas', aleatoria: true, limite: n });
  if (lista.length < n) {
    const ja = new Set(lista.map((q) => q.id));
    const mais = await chamar('questoes', estado.planoId, { aleatoria: true, limite: n * 2 });
    lista = [...lista, ...mais.filter((q) => !ja.has(q.id))].slice(0, n);
  }
  if (lista.length === 0) {
    alert('Ainda não há questões no banco para o bloco misturado.');
    return;
  }
  mostrar('questoes');
  iniciarRodada(lista, { blocoId: p.id });
}

// ---------- simulado ----------
// Cronômetro único, sem correção durante a prova; o gabarito e o resultado por matéria saem na entrega.
const sim = { lista: [], i: 0, escolhas: [], segundos: [], inicio: 0, limiteMin: 0, lote: null, abertaEm: 0, tique: null, entregando: false };

$('#s-montar').addEventListener('click', async () => {
  const n = Math.round(Number($('#s-por-materia').value) || 0);
  if (n < 1) return;
  const escolha = $('#s-lote').value;
  const pedido = {
    porMateria: Object.fromEntries(estado.materias.map((m) => [m.id, n])),
    lote: escolha && escolha !== '*' ? escolha : null,
    incluirReservados: escolha === '*',
  };
  const { questoes, faltas } = await chamar('montarSimulado', estado.planoId, pedido);
  if (questoes.length === 0) {
    $('#s-aviso').textContent = 'Nenhuma questão com essa escolha.';
    return;
  }
  $('#s-aviso').textContent = '';
  if (faltas.length) {
    const lista = faltas.map((f) => `${nomeMateria(f.materia_id)}: ${f.achadas} de ${f.pedidas}`).join('\n');
    if (!confirm(`Não há questões suficientes em:\n${lista}\n\nFazer o simulado com ${questoes.length} questões mesmo assim?`)) return;
  }
  iniciarSimulado(questoes, { limiteMin: Math.round(Number($('#s-tempo').value) || 0), lote: pedido.lote });
});

function iniciarSimulado(lista, { limiteMin, lote }) {
  Object.assign(sim, {
    lista, i: 0, escolhas: lista.map(() => null), segundos: lista.map(() => 0),
    inicio: Date.now(), limiteMin, lote, abertaEm: Date.now(), entregando: false,
  });
  $('#q-escolha').hidden = true;
  $('#q-fim').hidden = true;
  $('#q-simulado').hidden = false;
  clearInterval(sim.tique);
  sim.tique = setInterval(relogioSimulado, 1000);
  relogioSimulado();
  mostrarQuestaoSim();
}

function relogioSimulado() {
  const corridos = Math.floor((Date.now() - sim.inicio) / 1000);
  const z = (n) => String(n).padStart(2, '0');
  const fmt = (t) => `${t >= 3600 ? `${Math.floor(t / 3600)}:` : ''}${z(Math.floor((t % 3600) / 60))}:${z(t % 60)}`;
  if (sim.limiteMin) {
    const resta = Math.max(0, sim.limiteMin * 60 - corridos);
    $('#sim-relogio').textContent = `faltam ${fmt(resta)}`;
    $('#sim-relogio').classList.toggle('acabando', resta < 300);
    if (resta === 0) entregarSimulado(true);
  } else {
    $('#sim-relogio').textContent = fmt(corridos);
  }
}

function anotarTempoSim() {
  sim.segundos[sim.i] += (Date.now() - sim.abertaEm) / 1000;
  sim.abertaEm = Date.now();
}

function irParaSim(k) {
  if (k < 0 || k >= sim.lista.length) return;
  anotarTempoSim();
  sim.i = k;
  mostrarQuestaoSim();
}

function mostrarQuestaoSim() {
  const q = sim.lista[sim.i];
  const feitas = sim.escolhas.filter((e) => e !== null).length;
  $('#sim-posicao').textContent = `Questão ${sim.i + 1} de ${sim.lista.length} · ${feitas} respondidas`;
  $('#sim-mapa').innerHTML = sim.lista
    .map((_, k) => `<button data-k="${k}" class="${sim.escolhas[k] !== null ? 'respondida' : ''} ${k === sim.i ? 'aqui' : ''}">${k + 1}</button>`)
    .join('');
  $('#sim-mapa').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => irParaSim(Number(b.dataset.k))));
  $('#sim-meta').innerHTML = [
    q.materia && `<span class="etiqueta">${esc(q.materia)}</span>`,
    q.fonte && `<span class="etiqueta ${ehBanca(q.fonte) ? 'banca' : ''}">${esc(ehBanca(q.fonte) ? q.fonte : 'Autoral')}</span>`,
  ].filter(Boolean).join('');
  $('#sim-enunciado').innerHTML = limparHtml(q.enunciado);
  $('#sim-alternativas').innerHTML = q.alternativas
    .map((a, k) => `<button class="alt ${sim.escolhas[sim.i] === k ? 'escolhida' : ''}" data-i="${k}"><span class="letra">${LETRAS[k]}</span><span>${limparHtml(a)}</span></button>`)
    .join('');
  $('#sim-alternativas').querySelectorAll('.alt').forEach((b) => b.addEventListener('click', () => escolherSim(Number(b.dataset.i))));
  $('#sim-anterior').disabled = sim.i === 0;
  $('#sim-seguinte').disabled = sim.i === sim.lista.length - 1;
  document.querySelector('main').scrollTop = 0;
}

// Clicar de novo na mesma alternativa deixa a questão em branco.
function escolherSim(k) {
  sim.escolhas[sim.i] = sim.escolhas[sim.i] === k ? null : k;
  mostrarQuestaoSim();
}

$('#sim-anterior').addEventListener('click', () => irParaSim(sim.i - 1));
$('#sim-seguinte').addEventListener('click', () => irParaSim(sim.i + 1));
$('#sim-entregar').addEventListener('click', () => entregarSimulado(false));
$('#sim-desistir').addEventListener('click', () => {
  if (!confirm('Sair do simulado sem corrigir? Nada é registrado.')) return;
  fecharSimulado();
  $('#q-escolha').hidden = false;
  atualizar();
});

function fecharSimulado() {
  clearInterval(sim.tique);
  $('#q-simulado').hidden = true;
}

async function entregarSimulado(tempoAcabou) {
  if (sim.entregando) return;
  const brancas = sim.escolhas.filter((e) => e === null).length;
  if (!tempoAcabou && brancas && !confirm(`${brancas} ${brancas === 1 ? 'questão está' : 'questões estão'} em branco e contam como erro. Entregar mesmo assim?`)) return;
  sim.entregando = true;
  anotarTempoSim();
  const minutos = Math.max(1, Math.round((Date.now() - sim.inicio) / 60000));
  const r = await chamar('corrigirSimulado', estado.planoId, {
    respostas: sim.lista.map((q, k) => ({ questao_id: q.id, escolhida: sim.escolhas[k], segundos: sim.segundos[k] })),
    minutos,
    lote: sim.lote,
  });
  fecharSimulado();
  mostrarResultadoSimulado(r, tempoAcabou);
}

function mostrarResultadoSimulado(r, tempoAcabou) {
  const taxa = r.acertos / r.questoes;
  const brancas = r.por_materia.reduce((a, m) => a + m.em_branco, 0);
  const meta = (id) => estado.materias.find((m) => m.id === id)?.meta_acerto;
  const linhas = r.por_materia
    .map((m) => `<tr><td>${esc(m.materia)}</td><td>${m.questoes}</td><td>${m.acertos}</td>
        <td style="color:${corDoAcerto(m.acertos / m.questoes)}"><strong>${pct(m.acertos / m.questoes)}</strong></td>
        <td>${meta(m.materia_id) ? `${meta(m.materia_id)}%` : ''}</td></tr>`)
    .join('');
  const revisao = sim.lista
    .map((q, k) => {
      const g = r.gabarito[k];
      const marca = g.escolhida === null ? '<span class="branco">–</span>' : g.acertou ? '<span class="ok">✓</span>' : '<span class="nao">✗</span>';
      const alts = q.alternativas
        .map((a, i) => `<div class="alt ${i === g.correta ? 'certa' : i === g.escolhida ? 'errada' : ''}"><span class="letra">${LETRAS[i]}</span><span>${limparHtml(a)}</span></div>`)
        .join('');
      return `<details><summary>${marca} <strong>${k + 1}.</strong> ${esc(q.materia ?? '')}${q.tema ? ` · ${esc(q.tema)}` : ''}
          <span class="sutil">${g.escolhida === null ? 'em branco' : `marcou ${LETRAS[g.escolhida]}`}, gabarito ${LETRAS[g.correta]}</span></summary>
        <div class="q-enunciado">${limparHtml(q.enunciado)}</div><div class="q-alternativas">${alts}</div>
        ${q.comentario ? `<div class="q-comentario">${limparHtml(q.comentario)}</div>` : ''}</details>`;
    })
    .join('');
  $('#q-fim').hidden = false;
  $('#q-fim').innerHTML = `<h2>Simulado entregue${tempoAcabou ? ' (o tempo acabou)' : ''}</h2>
    <div class="fim-numero" style="color:${corDoAcerto(taxa)}">${pct(taxa)}</div>
    <p>${r.acertos} certas de ${r.questoes} em ${horas(r.minutos)}${brancas ? `, ${brancas} em branco` : ''}. Já está no histórico e no desempenho.</p>
    <table class="tabela"><thead><tr><th>Matéria</th><th>Questões</th><th>Acertos</th><th>Acerto</th><th>Meta</th></tr></thead><tbody>${linhas}</tbody></table>
    <h3>Gabarito</h3><div class="revisao-sim">${revisao}</div>
    <div class="botoes"><button class="primario" id="q-voltar">Voltar</button></div>`;
  $('#q-voltar').addEventListener('click', () => {
    $('#q-fim').hidden = true;
    $('#q-escolha').hidden = false;
    atualizar();
  });
}

// ---------- análise ----------
let _causas = null;
const causas = async () => (_causas ??= await chamar('causas'));
const corDoAcerto = (x) => (x === null ? 'var(--vazio)' : x >= 0.75 ? 'var(--bom)' : x >= 0.65 ? 'var(--medio)' : 'var(--ruim)');
const tempoQ = (s) => (s == null ? '' : s >= 60 ? `${Math.floor(s / 60)}min${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`);
let paraRefazer = [];

// Linhas de barra horizontal: nome, barra proporcional ao acerto e o número.
// metas: Map nome -> meta (0 a 1); aparece como um traço na barra e ao lado do número.
function barrasDeAcerto(linhas, vazio, metas = null) {
  if (!linhas.length) return `<p class="vazio-analise">${vazio}</p>`;
  return linhas
    .map((l) => {
      const meta = metas?.get(l.nome);
      return `<div class="linha-barra">
        <span class="nome" title="${esc(l.materia ? `${l.materia}: ${l.nome}` : l.nome)}">${esc(l.nome)}</span>
        <div class="trilho"><div style="width:${(l.acerto ?? 0) * 100}%;background:${corDoAcerto(l.acerto)}"></div>${
          meta != null ? `<span class="marca-meta" style="left:${meta * 100}%" title="meta ${pct(meta)}"></span>` : ''}</div>
        <span class="valor"><strong>${l.acerto === null ? '' : pct(l.acerto)}</strong> de ${l.respostas}${meta != null ? ` · meta ${pct(meta)}` : ''}</span></div>`;
    })
    .join('');
}

async function telaAnalise() {
  const a = await chamar('analise', estado.planoId);
  const g = a.geral;
  $('#a-acerto').textContent = g.respostas ? pct(g.acerto) : 'sem dados';
  $('#a-acerto').style.color = g.respostas ? corDoAcerto(g.acerto) : '';
  $('#a-respostas').textContent = `${g.respostas} respostas`;
  $('#a-tempo').textContent = g.segundos_medio ? tempoQ(g.segundos_medio) : 'sem dados';
  $('#a-cobertura').textContent = g.banco ? pct(g.questoes / g.banco) : '0%';
  $('#a-cobertura-det').textContent = `${g.questoes} de ${g.banco} questões`;
  $('#a-refazer').textContent = a.paraRefazer.length;

  $('#a-semanas').innerHTML = a.porSemana.length
    ? a.porSemana
        .map((s) => `<div class="col" title="${s.acertos} de ${s.respostas}">
            <span>${pct(s.acerto)}</span>
            <div style="height:${s.acerto * 100}%;background:${corDoAcerto(s.acerto)}"></div>
            <span>${dataBR(s.semana).slice(0, 5)}</span></div>`)
        .join('')
    : '<p class="vazio-analise">Responda questões para ver a evolução semana a semana.</p>';

  const c = a.causas;
  $('#a-causas-det').textContent = c.erros ? `${c.erros} erros, ${c.semCausa} sem causa marcada` : '';
  const maiorCausa = Math.max(1, ...c.lista.map((x) => x.total));
  $('#a-causas').innerHTML = c.erros
    ? c.lista
        .map((x) => `<div class="linha-barra"><span class="nome">${esc(x.rotulo)}</span>
            <div class="trilho"><div style="width:${(x.total / maiorCausa) * 100}%;background:var(--ruim)"></div></div>
            <span class="valor"><strong>${x.total}</strong>${c.erros - c.semCausa ? ` · ${pct(x.total / (c.erros - c.semCausa))}` : ''}</span></div>`)
        .join('')
    : '<p class="vazio-analise">Quando errar, marque o porquê logo abaixo da correção.</p>';

  const metas = new Map(estado.materias.filter((m) => m.meta_acerto).map((m) => [m.nome, m.meta_acerto / 100]));
  $('#a-materias').classList.toggle('com-meta', metas.size > 0);
  $('#a-materias').innerHTML = barrasDeAcerto(a.porMateria, 'Sem respostas ainda.', metas);
  $('#a-bancas').innerHTML = barrasDeAcerto(a.porBanca, 'Sem respostas ainda.');
  $('#a-temas').innerHTML = barrasDeAcerto(a.pioresTemas, 'Nenhum tema com erro e 2 ou mais respostas ainda.');

  paraRefazer = a.paraRefazer;
  $('#a-refazer-btn').hidden = paraRefazer.length === 0;
  $('#a-lista').innerHTML = paraRefazer.length
    ? paraRefazer
        .map((q) => `<li><div class="meio"><div><strong>${esc(q.materia ?? '')}</strong> · ${esc(q.tema ?? `questão ${q.numero}`)}</div>
            <div class="sutil">errou ${q.erros} de ${q.vezes} ${q.vezes === 1 ? 'vez' : 'vezes'}${q.ultima_causa ? ` · ${esc((_causas ?? {})[q.ultima_causa] ?? q.ultima_causa)}` : ''}${ehBanca(q.fonte) ? ` · ${esc(q.fonte)}` : ''}</div></div></li>`)
        .join('')
    : '<li><div class="meio"><div>Nada para refazer</div><div class="sutil">Questão errada aparece aqui até você acertar.</div></div></li>';
}

$('#a-refazer-btn').addEventListener('click', async () => {
  const lista = await chamar('questoes', estado.planoId, { ids: paraRefazer.map((q) => q.id), limite: 2000 });
  mostrar('questoes');
  iniciarRodada(lista);
});

// ---------- histórico ----------
async function telaHistorico() {
  const linhas = await chamar('historico', estado.planoId);
  $('#historico').innerHTML = linhas.length
    ? linhas
        .map((s) => `<tr>
          <td>${dataBR(s.inicio)} ${s.inicio.slice(11, 16)}</td>
          <td><span class="bola" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${cor(s.materia_id, s.cor)}"></span> ${esc(s.materia ?? '')}<div class="sutil">${esc(s.topico ?? '')}</div></td>
          <td>${TIPO[s.tipo]}${s.origem === 'claude' ? ' <span class="etiqueta">Claude</span>' : ''}</td>
          <td>${horas(s.duracao_min)}</td>
          <td>${s.acertos + s.erros ? `${s.acertos}/${s.acertos + s.erros}` : ''}</td>
          <td class="anot">${esc(s.anotacao ?? '')}</td>
          <td class="acoes-linha">
            <button data-editar="${s.id}" title="Corrigir este estudo">✏️ Corrigir</button>
            <button data-apagar="${s.id}" class="apagar" title="Apagar este estudo">🗑️</button>
          </td></tr>`)
        .join('')
    : '<tr><td colspan="7" class="sutil">Nenhum estudo registrado ainda.</td></tr>';
  $('#historico').querySelectorAll('[data-editar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const s = await chamar('obterSessao', Number(b.dataset.editar));
      if (s) abrirRegistro({ ...s, sessao_id: s.id });
    }),
  );
  $('#historico').querySelectorAll('[data-apagar]').forEach((b) =>
    b.addEventListener('click', async () => {
      const linha = b.closest('tr').querySelectorAll('td');
      const resumo = `${linha[0].textContent.trim()}, ${linha[1].firstChild.nextSibling?.textContent.trim() ?? ''} (${linha[3].textContent})`;
      if (!confirm(`Apagar o estudo de ${resumo}?\nAs revisões dele também saem. Não dá para desfazer.`)) return;
      await chamar('apagarSessao', Number(b.dataset.apagar));
      atualizar();
    }),
  );
}

// ---------- materiais ----------
async function telaMateriais() {
  const { pasta, lista } = await chamar('materiais', estado.planoId);
  $('#m-pasta').textContent = pasta ? `Pasta: ${pasta}` : 'Nenhuma pasta escolhida para este plano.';
  $('#m-atualizar').hidden = !pasta;
  $('#m-escolher').textContent = pasta ? 'Trocar pasta' : 'Escolher pasta';
  if (!pasta) {
    $('#m-aviso').textContent = 'Escolha a pasta onde estão os PDFs. Cada subpasta com o nome de uma matéria fica ligada a ela; o PDF continua onde está, o app só guarda o caminho e a página onde você parou.';
    $('#m-grupos').innerHTML = '';
    return;
  }
  $('#m-aviso').textContent = lista.length ? '' : 'Nenhum PDF nesta pasta.';

  // Um grupo por matéria, na ordem do edital; o que não casou com matéria fica agrupado pela pasta.
  const grupos = new Map();
  for (const m of lista) {
    const chave = m.materia_id ? `m${m.materia_id}` : `p${m.pasta.split(' / ')[0] || '(pasta principal)'}`;
    if (!grupos.has(chave)) grupos.set(chave, { titulo: m.materia ?? (m.pasta.split(' / ')[0] || 'Pasta principal'), materiaId: m.materia_id, cor: m.cor, itens: [] });
    grupos.get(chave).itens.push(m);
  }
  const porNome = (a, b) => `${a.pasta}/${a.nome}`.localeCompare(`${b.pasta}/${b.nome}`, 'pt-BR', { numeric: true });
  const opcoes = (atual) => `<option value="">Sem matéria</option>` + estado.materias
    .map((m) => `<option value="${m.id}" ${m.id === atual ? 'selected' : ''}>${esc(m.nome)}</option>`).join('');

  $('#m-grupos').innerHTML = [...grupos.values()].map((g) => `
    <div class="cartao grupo-material">
      <h3>${g.materiaId ? `<span class="ponto" style="background:${cor(g.materiaId, g.cor)}"></span>` : '📁'} ${esc(g.titulo)}
        <span class="sutil">${g.itens.length} PDF${g.itens.length === 1 ? '' : 's'}</span></h3>
      <ul class="materiais">${g.itens.sort(porNome).map((m) => {
        const lido = m.paginas ? m.ultima_pagina / m.paginas : 0;
        const sub = [m.pasta, m.aberto_em ? `aberto em ${dataBR(m.aberto_em)}` : 'nunca aberto'].filter(Boolean).join(' · ');
        return `<li>
          <div class="m-nome"><button data-abrir="${m.id}">${esc(m.nome)}</button><span class="sutil">${esc(sub)}</span></div>
          <select data-materia="${m.id}" aria-label="Matéria">${opcoes(m.materia_id)}</select>
          <div class="m-progresso"><span class="sutil">${m.paginas ? `pág. ${m.ultima_pagina} de ${m.paginas}` : ''}</span>
            <div class="m-barra"><div style="width:${lido * 100}%"></div></div></div>
          <button class="secundario" data-abrir="${m.id}">${m.aberto_em ? 'Continuar' : 'Abrir'}</button>
        </li>`;
      }).join('')}</ul>
    </div>`).join('');

  $('#m-grupos').querySelectorAll('[data-abrir]').forEach((b) => b.addEventListener('click', () => lerMaterial(Number(b.dataset.abrir))));
  $('#m-grupos').querySelectorAll('[data-materia]').forEach((s) => s.addEventListener('change', async () => {
    await chamar('associarMaterial', Number(s.dataset.materia), s.value ? Number(s.value) : null);
    telaMateriais();
  }));
}

async function lerMaterial(id) {
  mostrar('leitor');
  try {
    await abrirLeitor(await chamar('abrirMaterial', id), (materialId, pagina, paginas) => chamar('guardarPagina', materialId, pagina, paginas));
  } catch (erro) {
    $('#l-paginas').innerHTML = `<p class="sutil">Não foi possível abrir: ${esc(erro.message)}</p>`;
  }
}

async function escanear(nome) {
  $('#m-aviso').textContent = 'Lendo a pasta…';
  try {
    const r = await chamar(nome, estado.planoId);
    if (r) {
      await telaMateriais();
      $('#m-aviso').textContent = `${r.total} PDFs na pasta; ${r.novos} novos${r.sumiram ? `, ${r.sumiram} saíram da lista porque não estão mais lá` : ''}.${r.pastas_ilegiveis?.length ? ` Não deu para ler ${r.pastas_ilegiveis.length} subpasta(s); o que estava nelas continua na lista.` : ''}`;
    } else await telaMateriais();
  } catch (erro) {
    $('#m-aviso').textContent = erro.message;
  }
}
$('#m-escolher').addEventListener('click', () => escanear('escolherPastaMateriais'));
$('#m-atualizar').addEventListener('click', () => escanear('atualizarMateriais'));
$('#l-voltar').addEventListener('click', () => mostrar('materiais'));

// O Claude pode gravar no banco com o programa aberto: recarrega ao voltar para a janela e a cada 30 s,
// menos no meio de uma rodada de questões ou com a janela de registro aberta.
function recarregarSePuder() {
  if (dialogo.open || !$('#q-resolver').hidden || !$('#q-simulado').hidden || document.hidden) return;
  carregarPlanos(estado.planoId);
}
window.addEventListener('focus', recarregarSePuder);
setInterval(recarregarSePuder, 30000);

iniciar();
ligarTique();
