const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  onState: cb => ipcRenderer.on('tabs:state', (_e, s) => cb(s)),
  activate: key => ipcRenderer.send('tabs:activate', key),
  close: key => ipcRenderer.send('tabs:close', key),
  newTab: () => ipcRenderer.send('tabs:new'),
  home: () => ipcRenderer.send('tabs:home'),
  back: () => ipcRenderer.send('tabs:back'),
  forward: () => ipcRenderer.send('tabs:forward'),
  detach: (key, x, y) => ipcRenderer.send('tabs:detach', key, x, y),
  attach: key => ipcRenderer.send('tabs:attach', key),
  mute: key => ipcRenderer.send('tabs:mute', key),
  move: (key, index) => ipcRenderer.send('tabs:move', key, index),
  menu: key => ipcRenderer.send('tabs:menu', key),
});
