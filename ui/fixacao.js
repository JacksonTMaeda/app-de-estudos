// Telas de fixação: flashcards e mapas mentais. Só consulta; quem cria o conteúdo é o Claude, pelo MCP.
// Nada de innerHTML com texto do banco: tudo entra por textContent.

const COR_RAMO = ['#4f5bd5', '#e0748c', '#2f9e6a', '#d9a21b', '#3aa0c8', '#9b6ad6', '#e08a3c', '#5c9e3a'];
const dataBR = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('-') : '');
const paginasTexto = (de, ate) => (de ? (ate && ate !== de ? `p. ${de} a ${ate}` : `p. ${de}`) : '');

function el(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

function preencherSelect(sel, opcoes, valorAtual) {
  sel.replaceChildren(...opcoes.map(([valor, rotulo]) => {
    const o = el('option', '', rotulo);
    o.value = valor;
    return o;
  }));
  sel.value = opcoes.some(([v]) => String(v) === String(valorAtual)) ? valorAtual : opcoes[0][0];
}

export function iniciarFixacao({ chamar, estado, $ }) {
  // ---------- flashcards ----------
  const fc = { lista: [], i: 0, virado: false, baralhos: [] };

  function mostrarCartao() {
    const vazio = fc.lista.length === 0;
    $('#fc-area').hidden = vazio;
    if (vazio) return;
    const c = fc.lista[fc.i];
    $('#fc-lado').textContent = fc.virado ? 'Verso' : 'Frente';
    $('#fc-texto').textContent = fc.virado ? c.verso : c.frente;
    $('#fc-cartao').classList.toggle('virado', fc.virado);
    $('#fc-contador').textContent = `${fc.i + 1} de ${fc.lista.length}`;
    $('#fc-anterior').disabled = fc.i === 0;
    $('#fc-proximo').disabled = fc.i === fc.lista.length - 1;
  }

  function virar() {
    if (fc.lista.length === 0) return;
    fc.virado = !fc.virado;
    if (fc.virado) {
      const c = fc.lista[fc.i];
      c.vezes_visto = (c.vezes_visto || 0) + 1;
      chamar('marcarVisto', c.id);
    }
    mostrarCartao();
  }

  function ir(passo) {
    const novo = fc.i + passo;
    if (novo < 0 || novo >= fc.lista.length) return;
    fc.i = novo;
    fc.virado = false;
    mostrarCartao();
  }

  async function carregarCartoes(aleatorio) {
    const filtros = { aleatorio, limite: 2000 };
    if ($('#fc-materia').value) filtros.materiaId = Number($('#fc-materia').value);
    if ($('#fc-baralho').value) filtros.baralho = $('#fc-baralho').value;
    fc.lista = await chamar('flashcards', estado.planoId, filtros);
    fc.i = 0;
    fc.virado = false;
    mostrarCartao();
  }

  async function telaFlashcards() {
    const materiaAntes = $('#fc-materia').value;
    const baralhoAntes = $('#fc-baralho').value;
    fc.baralhos = await chamar('baralhos', estado.planoId);
    const semCartao = fc.baralhos.length === 0;
    $('#fc-vazio').hidden = !semCartao;
    $('#fc-filtros').hidden = semCartao;
    if (semCartao) {
      fc.lista = [];
      mostrarCartao();
      return;
    }
    const materias = new Map();
    for (const b of fc.baralhos) if (b.materia_id) materias.set(b.materia_id, b.materia);
    preencherSelect($('#fc-materia'), [['', 'Todas'], ...[...materias].map(([id, nome]) => [String(id), nome])], materiaAntes);
    preencherBaralhos(baralhoAntes);
    await carregarCartoes(false);
  }

  function preencherBaralhos(atual) {
    const materia = $('#fc-materia').value;
    const doFiltro = fc.baralhos.filter((b) => !materia || String(b.materia_id) === materia);
    const nomes = [...new Set(doFiltro.map((b) => b.baralho))];
    const qtd = (n) => doFiltro.filter((b) => b.baralho === n).reduce((s, b) => s + b.cartoes, 0);
    preencherSelect($('#fc-baralho'), [['', 'Todos'], ...nomes.map((n) => [n, `${n} (${qtd(n)})`])], atual);
  }

  $('#fc-materia').addEventListener('change', () => {
    preencherBaralhos('');
    carregarCartoes(false);
  });
  $('#fc-baralho').addEventListener('change', () => carregarCartoes(false));
  $('#fc-embaralhar').addEventListener('click', () => carregarCartoes(true));
  $('#fc-cartao').addEventListener('click', virar);
  $('#fc-anterior').addEventListener('click', () => ir(-1));
  $('#fc-proximo').addEventListener('click', () => ir(1));
  document.addEventListener('keydown', (e) => {
    if (estado.tela !== 'flashcards' || e.ctrlKey || e.metaKey || e.altKey) return;
    const alvo = e.target.tagName;
    if (alvo === 'SELECT' || alvo === 'INPUT' || alvo === 'TEXTAREA') return;
    if (e.key === ' ' && alvo !== 'BUTTON') {
      e.preventDefault();
      virar();
    } else if (e.key === 'ArrowRight') ir(1);
    else if (e.key === 'ArrowLeft') ir(-1);
  });

  // ---------- mapas mentais ----------
  const mp = { aberto: null };

  async function telaMapas() {
    if (mp.aberto) return;
    const antes = $('#mp-materia').value;
    const todos = await chamar('mapas', estado.planoId);
    const materias = new Map();
    for (const m of todos) if (m.materia_id) materias.set(m.materia_id, m.materia);
    preencherSelect($('#mp-materia'), [['', 'Todas'], ...[...materias].map(([id, nome]) => [String(id), nome])], antes);
    $('#mp-cabeca').hidden = todos.length === 0;
    $('#mp-vazio').hidden = todos.length > 0;
    const filtro = $('#mp-materia').value;
    const lista = filtro ? todos.filter((m) => String(m.materia_id) === filtro) : todos;
    $('#mp-lista').replaceChildren(...lista.map((m) => {
      const b = el('button', 'cartao mp-item-lista');
      b.type = 'button';
      b.append(el('strong', '', m.titulo));
      b.append(el('span', 'sutil', [m.materia ?? 'Sem matéria', paginasTexto(m.pagina_de, m.pagina_ate), dataBR(m.criado_em)].filter(Boolean).join(' · ')));
      b.addEventListener('click', () => abrirMapa(m.id));
      return b;
    }));
  }
  $('#mp-materia').addEventListener('change', telaMapas);

  const contarNos = (no) => no.filhos.reduce((s, f) => s + 1 + contarNos(f), 0);

  function desenharNo(no, nivel, cor) {
    const item = el('div', 'mp-item');
    item.style.setProperty('--cor', cor);
    const linha = el('div', 'mp-linha');
    const caixa = el('button', `mp-caixa nivel-${Math.min(nivel, 3)}`);
    caixa.type = 'button';
    caixa.append(el('span', '', no.texto));
    if (no.nota) caixa.title = no.nota;
    linha.append(caixa);
    item.append(linha);
    if (no.filhos.length > 0) {
      const sub = el('div', 'mp-filhos');
      sub.append(...no.filhos.map((f, i) => desenharNo(f, nivel + 1, nivel === 0 ? COR_RAMO[i % COR_RAMO.length] : cor)));
      item.append(sub);
      item.classList.add('tem-filhos');
      const total = contarNos(no);
      const marca = el('span', 'mp-marca', '');
      caixa.append(marca);
      item._atualizar = () => {
        const fechado = item.classList.contains('recolhido');
        marca.textContent = fechado ? `+${total}` : '';
        caixa.setAttribute('aria-expanded', String(!fechado));
      };
      caixa.addEventListener('click', () => {
        item.classList.toggle('recolhido');
        item._atualizar();
      });
      item._atualizar();
    }
    return item;
  }

  async function abrirMapa(id) {
    const mapa = await chamar('lerMapa', id);
    mp.aberto = mapa;
    $('#mp-lista-area').hidden = true;
    $('#mp-mapa-area').hidden = false;
    $('#mp-titulo').textContent = mapa.titulo;
    $('#mp-sub').textContent = [mapa.materia, paginasTexto(mapa.pagina_de, mapa.pagina_ate), dataBR(mapa.criado_em)].filter(Boolean).join(' · ');
    const raiz = desenharNo(mapa.arvore, 0, '#4f5bd5');
    raiz.classList.add('mp-raiz');
    $('#mp-arvore').replaceChildren(raiz);
    $('#mp-rolagem').scrollTo(0, 0);
  }

  function definirTodos(recolher) {
    for (const item of $('#mp-arvore').querySelectorAll('.mp-item.tem-filhos')) {
      item.classList.toggle('recolhido', recolher);
      item._atualizar();
    }
  }
  $('#mp-expandir').addEventListener('click', () => definirTodos(false));
  $('#mp-recolher').addEventListener('click', () => {
    definirTodos(true);
    // A raiz fica aberta: recolhida, o mapa sumiria numa caixa só.
    const raiz = $('#mp-arvore .mp-raiz');
    if (raiz?._atualizar) {
      raiz.classList.remove('recolhido');
      raiz._atualizar();
    }
  });
  $('#mp-voltar').addEventListener('click', () => {
    mp.aberto = null;
    $('#mp-mapa-area').hidden = true;
    $('#mp-lista-area').hidden = false;
    telaMapas();
  });

  return { telaFlashcards, telaMapas };
}
