// Processo principal do programa: abre a janela e atende os pedidos dela ao banco.
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import atualizador from 'electron-updater';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { abrirBanco, CAMINHO_PADRAO, copiaDeAbertura } from './db.js';
import { importarEdital } from './edital.js';
import { gerarCiclo } from './ciclo.js';
import * as servico from './servico.js';
import * as questoes from './questoes.js';
import { analisarQuestoes } from './analise.js';
import * as materiais from './materiais.js';

const aqui = dirname(fileURLToPath(import.meta.url));
const CAMINHO = process.env.ESTUDOS_DB || CAMINHO_PADRAO;
const db = abrirBanco(CAMINHO);
// Cópia antes de qualquer ajuste de banco que a versão nova traga (e uma por dia).
copiaDeAbertura(db, CAMINHO, app.getVersion());
questoes.prepararQuestoes(db);
materiais.prepararMateriais(db);
if (process.env.ESTUDOS_CAPTURA) app.disableHardwareAcceleration();

// Tudo que a janela pode pedir. Pela tela só se apaga estudo (Histórico); o Claude apaga mais pelo MCP.
const api = {
  versao: () => app.getVersion(),
  planos: () => servico.listarPlanos(db),
  resumo: (planoId) => servico.resumo(db, planoId),
  proximoBloco: (planoId) => servico.proximoBloco(db, planoId),
  ciclo: (planoId) => servico.cicloDoPlano(db, planoId),
  materias: (planoId) => servico.materiasComTopicos(db, planoId),
  historico: (planoId) => servico.historico(db, planoId),
  revisoes: (planoId) => servico.revisoesDoDia(db, planoId),
  registrarSessao: (planoId, dados) => servico.registrarSessao(db, planoId, dados),
  obterSessao: (sessaoId) => servico.obterSessao(db, sessaoId),
  editarSessao: (sessaoId, dados) => servico.editarSessao(db, sessaoId, dados),
  apagarSessao: (sessaoId) => servico.apagarSessao(db, sessaoId),
  pularBloco: (blocoId) => servico.pularBloco(db, blocoId),
  alternarTopico: (topicoId, concluido) => servico.alternarTopico(db, topicoId, concluido),
  concluirRevisao: (revisaoId, estado) => servico.concluirRevisao(db, revisaoId, estado),
  ajustarConhecimento: (planoId, materiaId, conhecimento) => {
    db.prepare('UPDATE materia SET conhecimento = ? WHERE id = ? AND plano_id = ?').run(conhecimento, materiaId, planoId);
    return gerarCiclo(db, planoId, opcoesDoCiclo(planoId)).blocos.length;
  },
  questoes: (planoId, filtros) => questoes.listarQuestoes(db, planoId, filtros),
  bancas: (planoId) => questoes.listarBancas(db, planoId),
  resumoQuestoes: (planoId) => questoes.resumoQuestoes(db, planoId),
  responderQuestao: (questaoId, escolhida, segundos) => questoes.responderQuestao(db, questaoId, escolhida, segundos),
  marcarCausa: (respostaId, causa) => questoes.marcarCausa(db, respostaId, causa),
  causas: () => questoes.CAUSAS,
  analise: (planoId) => analisarQuestoes(db, planoId),
  importarQuizzes: async (planoId) => {
    const escolha = await dialog.showOpenDialog({
      title: 'Escolha a pasta com os quizzes (.html)',
      properties: ['openDirectory'],
    });
    if (escolha.canceled || escolha.filePaths.length === 0) return null;
    return questoes.importarPasta(db, planoId, escolha.filePaths[0]);
  },
  materiais: (planoId) => ({
    pasta: materiais.pastaDoPlano(db, planoId),
    lista: materiais.listarMateriais(db, planoId),
  }),
  escolherPastaMateriais: async (planoId) => {
    const escolha = await dialog.showOpenDialog({
      title: 'Escolha a pasta dos materiais em PDF (uma subpasta por matéria)',
      properties: ['openDirectory'],
    });
    if (escolha.canceled || escolha.filePaths.length === 0) return null;
    return materiais.escanearPasta(db, planoId, escolha.filePaths[0]);
  },
  atualizarMateriais: (planoId) => {
    const pasta = materiais.pastaDoPlano(db, planoId);
    return pasta ? materiais.escanearPasta(db, planoId, pasta) : null;
  },
  associarMaterial: (materialId, materiaId) => materiais.associarMateria(db, materialId, materiaId),
  abrirMaterial: (materialId) => ({ ...materiais.obterMaterial(db, materialId), bytes: materiais.lerPdf(db, materialId) }),
  guardarPagina: (materialId, pagina, paginas) => materiais.guardarPagina(db, materialId, pagina, paginas),
  importarEdital: async () => {
    const escolha = await dialog.showOpenDialog({
      title: 'Escolha o edital em markdown',
      filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }],
      properties: ['openFile'],
    });
    if (escolha.canceled || escolha.filePaths.length === 0) return null;
    const arquivo = escolha.filePaths[0];
    const nomePlano = basename(arquivo).replace(/\.(md|txt)$/i, '');
    const { planoId } = importarEdital(db, { nomePlano, markdown: readFileSync(arquivo, 'utf8') });
    gerarCiclo(db, planoId);
    return planoId;
  },
};

function opcoesDoCiclo(planoId) {
  const c = db.prepare('SELECT * FROM ciclo WHERE plano_id = ?').get(planoId);
  return c ? { total: c.tempo_total_min, min: c.bloco_min, max: c.bloco_max, passo: c.passo_min } : {};
}

// Só as telas do próprio programa (ui/index.html) podem falar com o banco.
const TELA = pathToFileURL(join(aqui, '..', 'ui', 'index.html')).href;
const ehTelaDoPrograma = (url) => typeof url === 'string' && url.split('#')[0] === TELA;

ipcMain.handle('api', async (evento, nome, ...args) => {
  if (!ehTelaDoPrograma(evento.senderFrame?.url)) throw new Error('Pedido recusado: não veio da tela do programa.');
  if (!Object.hasOwn(api, nome)) throw new Error(`Pedido desconhecido: ${nome}`);
  return api[nome](...args);
});

// Link em questão ou comentário abre no navegador do sistema, nunca dentro do programa.
function travarNavegacao(janela) {
  const abrirFora = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  janela.webContents.setWindowOpenHandler(({ url }) => {
    abrirFora(url);
    return { action: 'deny' };
  });
  janela.webContents.on('will-navigate', (evento, url) => {
    if (ehTelaDoPrograma(url)) return;
    evento.preventDefault();
    abrirFora(url);
  });
  janela.webContents.on('will-attach-webview', (evento) => evento.preventDefault());
}

// Mostra e traz para a frente. Chamado duas vezes de propósito: no Windows, a primeira exibição
// de um programa aberto a partir de um terminal oculto herda o "fique escondido" de quem o abriu.
function mostrarJanela(janela) {
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.show();
  janela.focus();
}

function criarJanela() {
  const janela = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'App De Estudos',
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(aqui, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  travarNavegacao(janela);
  janela.once('ready-to-show', () => mostrarJanela(janela));
  janela.webContents.once('did-finish-load', () => janela.setTitle(`App De Estudos ${app.getVersion()}`));
  janela.loadFile(join(aqui, '..', 'ui', 'index.html'));
  // Conferência visual: ESTUDOS_CAPTURA=arquivo.png salva a tela de ESTUDOS_TELA e fecha.
  if (process.env.ESTUDOS_CAPTURA) {
    janela.webContents.once('did-finish-load', async () => {
      const tela = process.env.ESTUDOS_TELA;
      if (tela) await janela.webContents.executeJavaScript(`document.querySelector('nav [data-tela="${tela}"]').click()`);
      await new Promise((r) => setTimeout(r, 1500));
      if (process.env.ESTUDOS_CAPTURA_JS) {
        await janela.webContents.executeJavaScript(process.env.ESTUDOS_CAPTURA_JS);
        await new Promise((r) => setTimeout(r, 1000));
      }
      writeFileSync(process.env.ESTUDOS_CAPTURA, (await janela.webContents.capturePage()).toPNG());
      app.quit();
    });
  }
}

// Uma cópia só: abrir de novo traz a janela que já existe para a frente.
if (!process.env.ESTUDOS_CAPTURA && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  const [janela] = BrowserWindow.getAllWindows();
  if (janela) mostrarJanela(janela);
});

// Atualização automática pelas releases do GitHub, só no programa instalado (não ao rodar do código).
// Baixa em silêncio; quando termina, pergunta se pode reiniciar. Se não, instala ao fechar.
// O banco fica em Documentos e não é tocado; a cópia de abertura protege contra ajustes da versão nova.
function ligarAtualizacoes() {
  if (!app.isPackaged || process.env.ESTUDOS_CAPTURA) return;
  const { autoUpdater } = atualizador;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (erro) => console.error('Atualização:', erro?.message ?? erro));
  autoUpdater.on('update-downloaded', async (info) => {
    const [janela] = BrowserWindow.getAllWindows();
    const { response } = await dialog.showMessageBox(janela, {
      type: 'info',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
      cancelId: 1,
      title: 'Versão nova do App De Estudos',
      message: `A versão ${info.version} foi baixada.`,
      detail: 'Seus estudos e questões ficam como estão. Reiniciar agora para usar a versão nova? Se escolher "Depois", ela entra quando você fechar o programa.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  const conferir = () => autoUpdater.checkForUpdates().catch((erro) => console.error('Atualização:', erro?.message ?? erro));
  conferir();
  setInterval(conferir, 6 * 3600 * 1000);
}

app.whenReady().then(() => {
  criarJanela();
  ligarAtualizacoes();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && criarJanela());
});
app.on('window-all-closed', () => {
  db.close();
  app.quit();
});
