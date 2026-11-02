// Grifos, sublinhados e notas do leitor. Moram no banco do app, presos à impressão digital do PDF;
// o arquivo nunca é alterado. Retângulos em fração da página, para valer em qualquer zoom.
// A camada das marcas fica por baixo do texto do PDF.js (que recebe o clique), então o clique numa
// marca é achado pela posição, não pelo elemento.

const $ = (sel) => document.querySelector(sel);
const caixa = $('#l-paginas');
const menu = $('#l-menu');
const lista = $('#l-lista');
const CORES = ['amarelo', 'verde', 'azul', 'rosa'];
const LADO_NOTA = 22; // px do alfinete da nota solta, no zoom em que foi criada

const estado = { materialId: null, chamar: null, marcas: [], cor: 'amarelo', modo: null, aberta: null, irPara: null, salvarNota: null };

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const lerPreferencia = (chave, padrao) => {
  try {
    return localStorage.getItem(chave) ?? padrao;
  } catch {
    return padrao;
  }
};
estado.cor = CORES.includes(lerPreferencia('leitor_cor')) ? lerPreferencia('leitor_cor') : 'amarelo';

// irPara(pagina) leva o leitor até a página; o leitor passa ao ligar.
export function ligarMarcacoes(irPara) {
  estado.irPara = irPara;
}

export async function carregarMarcacoes(materialId, chamar) {
  estado.materialId = materialId;
  estado.chamar = chamar;
  estado.marcas = await chamar('marcacoes', materialId);
  mostrarLista();
}

export function limparMarcacoes() {
  fecharMenu();
  definirModo(null);
  estado.materialId = null;
  estado.marcas = [];
  lista.innerHTML = '';
}

// Camada de marcas de uma página, posta entre a imagem e o texto quando a página é desenhada.
export function camadaDeMarcas(pagina) {
  const camada = document.createElement('div');
  camada.className = 'l-marcas';
  preencher(camada, pagina);
  return camada;
}

const pct = (x) => `${(x * 100).toFixed(3)}%`;
function preencher(camada, pagina) {
  camada.innerHTML = estado.marcas.filter((m) => m.pagina === pagina).map((m) => {
    const escolhida = estado.aberta?.id === m.id ? ' escolhida' : '';
    if (m.tipo === 'nota') {
      const [x, y, l, a] = m.retangulos[0];
      return `<div class="alfinete${escolhida}" data-cor="${m.cor}" style="left:${pct(x)};top:${pct(y)};width:${pct(l)};height:${pct(a)}">✎</div>`;
    }
    const partes = m.retangulos.map(([x, y, l, a]) =>
      `<div class="${m.tipo}${escolhida}" data-cor="${m.cor}" style="left:${pct(x)};top:${pct(y)};width:${pct(l)};height:${pct(a)}"></div>`);
    if (m.nota) {
      const [x, y, l] = m.retangulos.at(-1);
      partes.push(`<div class="tem-nota" data-cor="${m.cor}" style="left:calc(${pct(x + l)} - 2px);top:calc(${pct(y)} - 6px)"></div>`);
    }
    return partes.join('');
  }).join('');
}

function redesenhar(pagina) {
  const camada = caixa.querySelector(`.l-pagina[data-n="${pagina}"] .l-marcas`);
  if (camada) preencher(camada, pagina);
}

// ---------- da seleção para retângulos ----------
const cabe = (x) => Math.min(1, Math.max(0, x));

// Junta os pedaços de uma mesma linha (o PDF.js põe um elemento por trecho de texto).
function juntarLinhas(rets) {
  rets.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const linhas = [];
  for (const r of rets) {
    const ultima = linhas.at(-1);
    const mesmaLinha = ultima && Math.min(ultima[1] + ultima[3], r[1] + r[3]) - Math.max(ultima[1], r[1]) > 0.5 * Math.min(ultima[3], r[3]);
    if (mesmaLinha && r[0] <= ultima[0] + ultima[2] + 0.02) {
      const x = Math.min(ultima[0], r[0]);
      const y = Math.min(ultima[1], r[1]);
      ultima[2] = Math.max(ultima[0] + ultima[2], r[0] + r[2]) - x;
      ultima[3] = Math.max(ultima[1] + ultima[3], r[1] + r[3]) - y;
      ultima[0] = x;
      ultima[1] = y;
    } else linhas.push([...r]);
  }
  return linhas;
}

// Trecho selecionado numa camada de texto. O toString() da seleção cola a última palavra de uma linha
// na primeira da seguinte, porque o PDF.js não põe espaço entre as linhas; aqui a troca de linha vira espaço.
function textoDaFaixa(faixa, camada) {
  let texto = '';
  let topo = null;
  for (const span of camada.querySelectorAll('span')) {
    const no = span.firstChild;
    if (span.children.length || no?.nodeType !== Node.TEXT_NODE || !faixa.intersectsNode(no)) continue;
    const pedaco = no.data.slice(faixa.startContainer === no ? faixa.startOffset : 0, faixa.endContainer === no ? faixa.endOffset : no.length);
    if (!pedaco) continue;
    const r = span.getBoundingClientRect();
    if (topo !== null && Math.abs(r.top - topo) > r.height / 2) texto += ' ';
    texto += pedaco;
    topo = r.top;
  }
  return texto.replace(/\s+/g, ' ').trim();
}

// A seleção pode passar de uma página para outra: devolve um pedaço por página, com o trecho de cada uma.
function pedacosDaSelecao() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
  const faixa = sel.getRangeAt(0);
  const pedacos = [];
  for (const div of caixa.querySelectorAll('.l-pagina')) {
    const texto = div.querySelector('.textLayer');
    if (!texto || !faixa.intersectsNode(texto)) continue;
    const parte = faixa.cloneRange();
    if (!texto.contains(faixa.startContainer)) parte.setStart(texto, 0);
    if (!texto.contains(faixa.endContainer)) parte.setEnd(texto, texto.childNodes.length);
    const p = div.getBoundingClientRect();
    const rets = [...parte.getClientRects()]
      .filter((c) => c.width > 1 && c.height > 1 && c.height < p.height * 0.08)
      .map((c) => {
        const x = cabe((c.left - p.left) / p.width);
        const y = cabe((c.top - p.top) / p.height);
        return [x, y, cabe((c.right - p.left) / p.width) - x, cabe((c.bottom - p.top) / p.height) - y];
      })
      .filter(([, , l, a]) => l > 0 && a > 0);
    const trecho = textoDaFaixa(parte, texto);
    if (rets.length && trecho) pedacos.push({ pagina: Number(div.dataset.n), retangulos: juntarLinhas(rets), texto: trecho });
  }
  return pedacos;
}

async function criar(pedaco, tipo, cor = estado.cor) {
  const nova = await estado.chamar('marcar', estado.materialId, { ...pedaco, tipo, cor });
  estado.marcas.push(nova);
  redesenhar(nova.pagina);
  mostrarLista();
  return nova;
}

async function marcarSelecao(tipo, cor) {
  const pedacos = pedacosDaSelecao();
  getSelection().removeAllRanges();
  fecharMenu();
  const feitas = [];
  for (const p of pedacos) feitas.push(await criar(p, tipo, cor));
  return feitas;
}

// ---------- menus ----------
function posicionar(x, y) {
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
  menu.style.top = `${y + 14 + height > innerHeight ? Math.max(8, y - height - 14) : y + 14}px`;
}

const botoesDeCor = (atual) =>
  `<span class="cores">${CORES.map((c, i) => `<button data-cor="${c}" class="${c === atual ? 'escolhida' : ''}" title="${c[0].toUpperCase() + c.slice(1)} (${i + 1})"></button>`).join('')}</span>`;

// Menu do trecho selecionado: grifar numa cor, sublinhar, grifar com nota, copiar.
function menuDaSelecao(x, y) {
  fecharMenu();
  menu.dataset.tipo = 'selecao';
  menu.innerHTML = `<div class="linha">${botoesDeCor(estado.cor)}
      <button class="texto" data-acao="sublinhar" title="Sublinhar (S)"><u>S</u></button>
      <button class="texto" data-acao="nota" title="Grifar e anotar (N)">📝</button>
      <button class="texto" data-acao="copiar" title="Copiar (Ctrl+C)">Copiar</button></div>`;
  menu.querySelectorAll('[data-cor]').forEach((b) => b.addEventListener('click', () => {
    escolherCor(b.dataset.cor);
    marcarSelecao('grifo', b.dataset.cor);
  }));
  menu.querySelector('[data-acao="sublinhar"]').addEventListener('click', () => marcarSelecao('sublinhado'));
  menu.querySelector('[data-acao="nota"]').addEventListener('click', () => grifarComNota(x, y));
  menu.querySelector('[data-acao="copiar"]').addEventListener('click', () => {
    navigator.clipboard.writeText(getSelection().toString());
    fecharMenu();
  });
  posicionar(x, y);
}

async function grifarComNota(x, y) {
  const [primeira] = await marcarSelecao('grifo');
  if (primeira) menuDaMarca(primeira, x, y, true);
}

// Menu de uma marca já feita: trocar cor, trocar grifo e sublinhado, escrever a nota, apagar.
function menuDaMarca(marca, x, y, focarNota = false) {
  fecharMenu(estado.aberta === marca);
  estado.aberta = marca;
  redesenhar(marca.pagina);
  menu.dataset.tipo = 'marca';
  const trocar = marca.tipo === 'nota' ? '' : `<button class="texto" data-acao="trocar">${marca.tipo === 'grifo' ? '<u>S</u> Sublinhar' : 'Grifar'}</button>`;
  menu.innerHTML = `<div class="linha">${botoesDeCor(marca.cor)}${trocar}
      <button class="texto apagar" data-acao="apagar">Apagar</button></div>
    <textarea placeholder="Nota (salva sozinha)">${esc(marca.nota)}</textarea>`;
  menu.querySelectorAll('[data-cor]').forEach((b) => b.addEventListener('click', () => editar(marca, { cor: b.dataset.cor })));
  menu.querySelector('[data-acao="trocar"]')?.addEventListener('click', () => editar(marca, { tipo: marca.tipo === 'grifo' ? 'sublinhado' : 'grifo' }));
  menu.querySelector('[data-acao="apagar"]').addEventListener('click', () => apagar(marca));
  const campo = menu.querySelector('textarea');
  campo.addEventListener('input', () => {
    clearTimeout(estado.salvarNota);
    estado.salvarNota = setTimeout(() => editar(marca, { nota: campo.value }, false), 600);
  });
  posicionar(x, y);
  if (focarNota || marca.tipo === 'nota') campo.focus();
}

async function editar(marca, dados, refazerMenu = true) {
  const nova = await estado.chamar('editarMarcacao', marca.id, dados);
  Object.assign(marca, nova);
  redesenhar(marca.pagina);
  mostrarLista();
  if (refazerMenu && estado.aberta === marca) {
    const { left, top } = menu.getBoundingClientRect();
    menuDaMarca(marca, left, top - 14);
  }
}

async function apagar(marca) {
  clearTimeout(estado.salvarNota);
  estado.salvarNota = null;
  await estado.chamar('apagarMarcacao', marca.id);
  estado.marcas = estado.marcas.filter((m) => m !== marca);
  estado.aberta = null;
  fecharMenu();
  redesenhar(marca.pagina);
  mostrarLista();
}

// Fecha o menu gravando a nota que ainda estava esperando. Nota solta que ficou vazia é apagada,
// menos quando o menu só está sendo refeito (manter), como ao trocar a cor.
function fecharMenu(manter = false) {
  const marca = estado.aberta;
  const digitado = menu.querySelector('textarea')?.value;
  const pendente = estado.salvarNota;
  clearTimeout(estado.salvarNota);
  estado.salvarNota = null;
  menu.hidden = true;
  menu.innerHTML = '';
  delete menu.dataset.tipo;
  estado.aberta = null;
  if (!marca) return;
  redesenhar(marca.pagina);
  if (!manter && marca.tipo === 'nota' && !(digitado ?? marca.nota ?? '').trim() && estado.marcas.includes(marca)) apagar(marca);
  else if (pendente) {
    marca.nota = digitado; // o menu refeito já mostra o que foi digitado, antes de o banco responder
    editar(marca, { nota: digitado }, false);
  }
}

// ---------- ferramentas da barra ----------
function escolherCor(cor) {
  estado.cor = cor;
  try {
    localStorage.setItem('leitor_cor', cor);
  } catch {
    // sem preferência guardada, a cor volta ao amarelo na próxima vez
  }
  document.querySelectorAll('.l-cores button').forEach((b) => b.classList.toggle('escolhida', b.dataset.cor === cor));
}

// Modos: 'marcatexto' (toda seleção vira grifo) e 'nota' (o próximo clique põe uma nota solta).
function definirModo(modo) {
  estado.modo = estado.modo === modo ? null : modo;
  caixa.classList.toggle('modo-marcatexto', estado.modo === 'marcatexto');
  caixa.classList.toggle('modo-nota', estado.modo === 'nota');
  $('#l-marcatexto').classList.toggle('ligado', estado.modo === 'marcatexto');
  $('#l-nova-nota').classList.toggle('ligado', estado.modo === 'nota');
}

function mostrarLista() {
  $('#l-contagem').textContent = estado.marcas.length || '';
  if (lista.hidden) return;
  if (estado.marcas.length === 0) {
    lista.innerHTML = '<h3>Marcações</h3><p class="sutil">Selecione um trecho do PDF para grifar, sublinhar ou anotar.</p>';
    return;
  }
  lista.innerHTML = `<h3>Marcações (${estado.marcas.length})</h3>${estado.marcas.map((m) => `
    <button data-id="${m.id}" data-cor="${m.cor}">
      <span class="sutil">p. ${m.pagina}${m.tipo === 'sublinhado' ? ' · sublinhado' : m.tipo === 'nota' ? ' · nota' : ''}</span>
      ${m.texto ? `<span class="trecho">${esc(m.texto)}</span>` : ''}
      ${m.nota ? `<span class="nota">${esc(m.nota)}</span>` : ''}
    </button>`).join('')}`;
  lista.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => {
    const marca = estado.marcas.find((m) => m.id === Number(b.dataset.id));
    estado.irPara?.(marca.pagina, marca.retangulos[0]?.[1] ?? 0);
  }));
}

document.querySelectorAll('.l-cores button').forEach((b) => b.addEventListener('click', () => escolherCor(b.dataset.cor)));
escolherCor(estado.cor);
$('#l-marcatexto').addEventListener('click', () => definirModo('marcatexto'));
$('#l-nova-nota').addEventListener('click', () => definirModo('nota'));
$('#l-ver-lista').addEventListener('click', () => {
  lista.hidden = !lista.hidden;
  $('#l-ver-lista').classList.toggle('ligado', !lista.hidden);
  mostrarLista();
});

const telaLeitor = $('#tela-leitor');
function alternarTelaCheia() {
  if (document.fullscreenElement) document.exitFullscreen();
  else telaLeitor.requestFullscreen();
}
$('#l-tela-cheia').addEventListener('click', alternarTelaCheia);

// ---------- mouse e teclado ----------
// Qual marca está sob o ponto (a de cima, a mais nova, ganha).
function marcaEm(div, clientX, clientY) {
  const p = div.getBoundingClientRect();
  const x = (clientX - p.left) / p.width;
  const y = (clientY - p.top) / p.height;
  const folgaX = 3 / p.width;
  const folgaY = 3 / p.height;
  const n = Number(div.dataset.n);
  return estado.marcas.filter((m) => m.pagina === n).reverse().find((m) =>
    m.retangulos.some(([rx, ry, l, a]) => x >= rx - folgaX && x <= rx + l + folgaX && y >= ry - folgaY && y <= ry + a + folgaY));
}

async function notaSolta(div, clientX, clientY) {
  definirModo(null);
  const p = div.getBoundingClientRect();
  const l = LADO_NOTA / p.width;
  const a = LADO_NOTA / p.height;
  const x = cabe((clientX - p.left) / p.width - l / 2);
  const y = cabe((clientY - p.top) / p.height - a / 2);
  const nova = await criar({ pagina: Number(div.dataset.n), retangulos: [[Math.min(x, 1 - l), Math.min(y, 1 - a), l, a]], texto: '' }, 'nota');
  menuDaMarca(nova, clientX, clientY, true);
}

caixa.addEventListener('mouseup', (e) => {
  if (!estado.materialId || e.button !== 0) return;
  // Espera a seleção assentar (o clique duplo e o triplo selecionam palavra e linha depois do mouseup).
  setTimeout(() => {
    const div = e.target.closest?.('.l-pagina');
    const sel = getSelection();
    if (sel && !sel.isCollapsed && caixa.contains(sel.anchorNode)) {
      if (estado.modo === 'marcatexto') marcarSelecao('grifo');
      else menuDaSelecao(e.clientX, e.clientY);
      return;
    }
    if (!div) return;
    if (estado.modo === 'nota') return notaSolta(div, e.clientX, e.clientY);
    const marca = marcaEm(div, e.clientX, e.clientY);
    if (marca) menuDaMarca(marca, e.clientX, e.clientY);
    else fecharMenu();
  }, 0);
});

document.addEventListener('mousedown', (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !caixa.contains(e.target)) fecharMenu();
});
caixa.addEventListener('mousedown', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) fecharMenu();
});
caixa.addEventListener('scroll', () => menu.dataset.tipo === 'selecao' && fecharMenu());

document.addEventListener('keydown', (e) => {
  if (telaLeitor.hidden || !estado.materialId || e.ctrlKey || e.altKey || e.metaKey || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    if (!menu.hidden) fecharMenu();
    else if (estado.modo) definirModo(null);
    return;
  }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const tecla = e.key.toLowerCase();
  const temSelecao = !getSelection().isCollapsed && caixa.contains(getSelection().anchorNode);
  if (/^[1-4]$/.test(tecla)) {
    escolherCor(CORES[Number(tecla) - 1]);
    if (temSelecao) marcarSelecao('grifo');
    else if (estado.aberta) editar(estado.aberta, { cor: estado.cor });
  } else if (tecla === 's' && temSelecao) marcarSelecao('sublinhado');
  else if (tecla === 'n' && temSelecao) {
    const r = getSelection().getRangeAt(0).getBoundingClientRect();
    grifarComNota(r.left, r.bottom);
  } else if (tecla === 'n') definirModo('nota');
  else if (tecla === 'm') definirModo('marcatexto');
  else if (tecla === 'f') alternarTelaCheia();
  else if ((tecla === 'delete' || tecla === 'backspace') && estado.aberta) apagar(estado.aberta);
  else return;
  e.preventDefault();
});
