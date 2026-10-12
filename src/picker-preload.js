const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('platine', {
  platforms: () => ipcRenderer.invoke('platforms'),
  choose: id => ipcRenderer.send('choose', id),
});
