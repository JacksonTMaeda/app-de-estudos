// Leitor de PDF (PDF.js). Desenha só as páginas perto da tela, guarda a página onde parou
// e põe o texto da página por cima da imagem, para selecionar e copiar.
import * as pdfjs from '../node_modules/pdfjs-dist/build/pdf.min.mjs';

const BASE = new URL('../node_modules/pdfjs-dist/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}build/pdf.worker.min.mjs`;

const $ = (sel) => document.querySelector(sel);
const caixa = $('#l-paginas');
const leitor = { material: null, doc: null, escala: 1, tamanho: null, pagina: 1, salvar: null, observador: null, guardar: null };

const escalaSalva = () => Number(localStorage.getItem('leitor_escala')) || null;

// Abre o material na página onde parou. guardar(id, pagina, paginas) grava no banco.
export async function abrirLeitor(material, guardar) {
  await fecharLeitor();
  leitor.material = material;
  leitor.guardar = guardar;
  $('#l-nome').textContent = material.nome;
  $('#l-materia').textContent = material.materia ?? material.pasta ?? '';
  caixa.innerHTML = '<p class="sutil">Abrindo…</p>';
  leitor.doc = await pdfjs.getDocument({
    data: material.bytes,
    cMapUrl: `${BASE}cmaps/`,
    standardFontDataUrl: `${BASE}standard_fonts/`,
    wasmUrl: `${BASE}wasm/`,
    iccUrl: `${BASE}iccs/`,
  }).promise;
  const primeira = await leitor.doc.getPage(1);
  const v = primeira.getViewport({ scale: 1 });
  leitor.tamanho = { largura: v.width, altura: v.height };
  // Primeira vez: a página ocupa a largura do leitor. Depois, vale o zoom que a pessoa escolheu.
  leitor.escala = escalaSalva() ?? limitar((caixa.clientWidth - 40) / v.width);
  $('#l-total').textContent = `de ${leitor.doc.numPages}`;
  $('#l-pagina').max = leitor.doc.numPages;
  montarPaginas(Math.min(material.ultima_pagina || 1, leitor.doc.numPages));
  guardar(material.id, leitor.pagina, leitor.doc.numPages);
}

export async function fecharLeitor() {
  if (!leitor.doc) return;
  clearTimeout(leitor.salvar);
  await leitor.guardar(leitor.material.id, leitor.pagina, leitor.doc.numPages);
  leitor.observador?.disconnect();
  const doc = leitor.doc;
  leitor.doc = null;
  caixa.innerHTML = '';
  await doc.destroy();
}

const limitar = (x) => Math.min(4, Math.max(0.4, Math.round(x * 20) / 20));

function montarPaginas(irPara) {
  leitor.observador?.disconnect();
  const { largura, altura } = leitor.tamanho;
  const total = leitor.doc.numPages;
  caixa.innerHTML = Array.from({ length: total }, (_, i) =>
    `<div class="l-pagina" data-n="${i + 1}" style="width:${largura * leitor.escala}px;height:${altura * leitor.escala}px"><span class="num">${i + 1}</span></div>`,
  ).join('');
  $('#l-zoom').textContent = `${Math.round(leitor.escala * 100)}%`;
  leitor.observador = new IntersectionObserver(
    (itens) => itens.forEach((it) => (it.isIntersecting ? desenhar(it.target) : apagar(it.target))),
    { root: caixa, rootMargin: '1200px 0px' },
  );
  caixa.querySelectorAll('.l-pagina').forEach((p) => leitor.observador.observe(p));
  irParaPagina(irPara);
}

async function desenhar(div) {
  if (div.dataset.escala === String(leitor.escala)) return;
  const doc = leitor.doc;
  const escala = leitor.escala;
  div.dataset.escala = String(escala);
  const page = await doc.getPage(Number(div.dataset.n));
  if (doc !== leitor.doc || div.dataset.escala !== String(escala)) return;
  const vp = page.getViewport({ scale: escala });
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  const camada = document.createElement('div');
  camada.className = 'textLayer';
  div.style.width = `${vp.width}px`;
  div.style.height = `${vp.height}px`;
  div.style.setProperty('--scale-factor', escala);
  div.style.setProperty('--user-unit', 1);
  div.style.setProperty('--total-scale-factor', escala);
  try {
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] }).promise;
    if (div.dataset.escala !== String(escala) || doc !== leitor.doc) return;
    div.replaceChildren(canvas, camada);
    await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: camada, viewport: vp }).render();
  } catch (erro) {
    if (erro?.name !== 'RenderingCancelledException') console.error('Leitor:', erro);
  }
}

// Página que saiu de perto da tela volta a ser só o número, para não acumular memória em PDF grande.
function apagar(div) {
  if (!div.dataset.escala) return;
  delete div.dataset.escala;
  div.replaceChildren(Object.assign(document.createElement('span'), { className: 'num', textContent: div.dataset.n }));
}

function irParaPagina(n) {
  const total = leitor.doc?.numPages ?? 1;
  n = Math.min(total, Math.max(1, Math.floor(n) || 1));
  const alvo = caixa.querySelector(`.l-pagina[data-n="${n}"]`);
  if (alvo) caixa.scrollTop = alvo.offsetTop - 8;
  marcarPagina(n);
}

function marcarPagina(n) {
  if (n === leitor.pagina && $('#l-pagina').value === String(n)) return;
  leitor.pagina = n;
  $('#l-pagina').value = n;
  clearTimeout(leitor.salvar);
  leitor.salvar = setTimeout(() => leitor.doc && leitor.guardar(leitor.material.id, n, leitor.doc.numPages), 800);
}

// A página atual é a que ocupa a linha a um terço da altura do leitor.
let quadro = 0;
caixa.addEventListener('scroll', () => {
  if (!leitor.doc || quadro) return;
  quadro = requestAnimationFrame(() => {
    quadro = 0;
    const linha = caixa.scrollTop + caixa.clientHeight / 3;
    for (const p of caixa.children) {
      if (p.offsetTop + p.offsetHeight > linha) return marcarPagina(Number(p.dataset.n));
    }
  });
});

function mudarZoom(fator) {
  if (!leitor.doc) return;
  const pagina = leitor.pagina;
  leitor.escala = limitar(leitor.escala * fator);
  localStorage.setItem('leitor_escala', leitor.escala);
  montarPaginas(pagina);
}

$('#l-pagina').addEventListener('change', (e) => irParaPagina(Number(e.target.value)));
$('#l-anterior').addEventListener('click', () => irParaPagina(leitor.pagina - 1));
$('#l-seguinte').addEventListener('click', () => irParaPagina(leitor.pagina + 1));
$('#l-menos').addEventListener('click', () => mudarZoom(1 / 1.15));
$('#l-mais').addEventListener('click', () => mudarZoom(1.15));
caixa.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  mudarZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
}, { passive: false });
