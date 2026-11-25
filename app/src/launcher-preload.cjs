// The launcher window's bridge to the main process (see src/launcher.js).
const { contextBridge, ipcRenderer } = require('electron');

const call = (name, ...args) => ipcRenderer.invoke(`senju:${name}`, ...args);

contextBridge.exposeInMainWorld('senju', {
  state: () => call('state'),
  chooseMode: (mode) => call('choose-mode', mode),
  saveSettings: (settings) => call('save-settings', settings),
  signIn: (email, password) => call('sign-in', email, password),
  signOut: () => call('sign-out'),
  openWeb: () => call('open-web'),

  sessions: () => call('sessions'),
  session: (id) => call('session', id),
  send: (goal, sessionId) => call('send', goal, sessionId),
  rename: (id, title) => call('rename', id, title),
  remove: (id) => call('remove', id),
  showOverlay: () => call('show-overlay'),

  skills: () => call('skills'),
  saveSkill: (skill) => call('save-skill', skill),
  deleteSkill: (name) => call('delete-skill', name),
  notes: () => call('notes'),
  addNote: (note, scope) => call('add-note', note, scope),
  deleteNote: (id) => call('delete-note', id),

  onEvent: (fn) => ipcRenderer.on('senju:event', (_e, msg) => fn(msg)),
});
