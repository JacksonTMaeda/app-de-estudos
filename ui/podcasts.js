// Player dos podcasts: uma barra fixa embaixo da janela, que continua tocando ao trocar de tela.
// Guarda onde parou a cada 15 s e ao pausar; tocou até o fim, marca como ouvido.
const VELOCIDADES = [1, 1.25, 1.5, 1.75, 2];
const lerPref = (chave, padrao) => {
  try {
    return localStorage.getItem(chave) ?? padrao;
  } catch {
    return padrao;
  }
};
const gravarPref = (chave, valor) => {
  try {
    localStorage.setItem(chave, valor);
  } catch {
    // sem localStorage o player funciona igual, só não lembra a velocidade
  }
};

export const tempo = (s) => {
  if (!(s >= 0)) return '';
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const seg = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${seg}` : `${m}:${seg}`;
};

export function iniciarPlayer({ chamar, $, aoMudar }) {
  const barra = $('#player');
  const audio = $('#p-audio');
  const velocidade = $('#p-velocidade');
  velocidade.innerHTML = VELOCIDADES.map((v) => `<option value="${v}">${String(v).replace('.', ',')}x</option>`).join('');
  velocidade.value = String(VELOCIDADES.includes(Number(lerPref('podcast_velocidade', 1))) ? Number(lerPref('podcast_velocidade', 1)) : 1);

  let atual = null; // { id, url }
  let ultimoSalvo = 0;

  const salvar = async () => {
    if (!atual || !(audio.duration > 0)) return;
    ultimoSalvo = Date.now();
    await chamar('guardarPosicao', atual.id, audio.currentTime, audio.duration);
  };

  async function fechar() {
    if (!atual) return;
    audio.pause();
    await salvar();
    URL.revokeObjectURL(atual.url);
    audio.removeAttribute('src');
    audio.load();
    atual = null;
    barra.hidden = true;
    document.body.classList.remove('com-player');
    aoMudar?.();
  }

  async function tocar(id) {
    if (atual?.id === id) {
      audio.paused ? audio.play() : audio.pause();
      return;
    }
    await fechar();
    $('#p-nome').textContent = 'Carregando…';
    $('#p-materia').textContent = '';
    barra.hidden = false;
    document.body.classList.add('com-player');
    let dados;
    try {
      dados = await chamar('abrirAudio', id);
    } catch (erro) {
      $('#p-nome').textContent = `Não foi possível abrir: ${erro.message}`;
      return;
    }
    const url = URL.createObjectURL(new Blob([dados.bytes], { type: dados.tipo }));
    atual = { id, url };
    $('#p-nome').textContent = dados.nome;
    $('#p-materia').textContent = dados.materia ?? '';
    audio.src = url;
    audio.addEventListener('loadedmetadata', () => {
      // Volta de onde parou, menos se parou no finalzinho (aí recomeça).
      if (dados.posicao > 5 && dados.posicao < audio.duration - 10) audio.currentTime = Math.max(0, dados.posicao - 3);
      audio.playbackRate = Number(velocidade.value);
      audio.play().catch(() => {});
    }, { once: true });
  }

  audio.addEventListener('timeupdate', () => {
    if (atual && !audio.paused && Date.now() - ultimoSalvo > 15000) salvar();
  });
  audio.addEventListener('play', () => aoMudar?.());
  audio.addEventListener('pause', () => {
    if (atual && !audio.ended) salvar().then(() => aoMudar?.());
  });
  audio.addEventListener('ended', async () => {
    if (!atual) return;
    await salvar();
    await chamar('marcarOuvido', atual.id, true);
    aoMudar?.();
  });
  velocidade.addEventListener('change', () => {
    audio.playbackRate = Number(velocidade.value);
    gravarPref('podcast_velocidade', velocidade.value);
  });
  $('#p-voltar').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  $('#p-avancar').addEventListener('click', () => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30); });
  $('#p-fechar').addEventListener('click', fechar);
  window.addEventListener('beforeunload', () => { salvar(); });

  return { tocar, tocandoId: () => atual?.id ?? null, tocando: () => !!atual && !audio.paused };
}
