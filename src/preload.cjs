// Ponte segura entre a janela e o processo principal: a janela só consegue chamar o que está em main.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('estudos', {
  chamar: (nome, ...args) => ipcRenderer.invoke('api', nome, ...args),
});
