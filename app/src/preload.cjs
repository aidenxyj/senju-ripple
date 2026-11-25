const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swarm', {
  submit: (goal) => ipcRenderer.send('swarm:submit', goal),
  answer: (qid, text) => ipcRenderer.send('swarm:answer', { qid, text }),
  tell: (text, target) => ipcRenderer.send('swarm:tell', { text, target }),
  cancel: () => ipcRenderer.send('swarm:cancel'),
  pause: (id, paused) => ipcRenderer.send('swarm:pause', { id, paused }),
  stopAgent: (id) => ipcRenderer.send('swarm:stop-agent', id),
  dismiss: () => ipcRenderer.send('swarm:dismiss'),
  reset: () => ipcRenderer.send('swarm:reset'),
  signIn: (email, password) => ipcRenderer.send('team:signin', { email, password }),
  signOut: () => ipcRenderer.send('team:signout'),
  consent: (allow, watch = false) => ipcRenderer.send('team:consent', { allow, watch }),
  join: () => ipcRenderer.send('team:join'),
  leave: () => ipcRenderer.send('team:leave'),
  setMode: (mode) => ipcRenderer.send('app:mode', mode),
  saveSettings: (settings) => ipcRenderer.send('solo:settings', settings),
  setInteractive: (on) => ipcRenderer.send('overlay:interactive', on),
  openApp: () => ipcRenderer.send('app:open-launcher'),
  onEvent: (fn) => ipcRenderer.on('swarm:event', (_e, event) => fn(event)),
});
