// The launcher: Senju's main window. It opens first, asks how to work (personal or team), and then
// works like a chat app: past sessions on the left, the selected one on the right, a box to start a
// new one or continue. While a job runs it steps aside for the overlay (bar, cursors, request cards).
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';

export class Launcher {
  /**
   * @param {object} o
   * @param {string} o.root           the app folder
   * @param {object} o.handlers       name -> async function, called from the window (see launcher-preload.cjs)
   */
  constructor({ root, handlers }) {
    this.root = root;
    this.win = null;
    for (const [name, fn] of Object.entries(handlers)) {
      ipcMain.handle(`senju:${name}`, async (_e, ...args) => {
        try { return { ok: true, value: await fn(...args) }; } catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
      });
    }
  }

  create() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      width: 1180, height: 780, minWidth: 820, minHeight: 560,
      show: false, title: 'Senju',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 18, y: 18 },
      backgroundColor: '#F42902',
      webPreferences: { preload: path.join(this.root, 'src', 'launcher-preload.cjs'), contextIsolation: true },
    });
    this.win.loadFile(path.join(this.root, 'launcher', 'index.html'));
    // Closing the window hides it: Senju keeps running in the menu bar.
    this.win.on('close', (e) => { if (!app.quitting) { e.preventDefault(); this.hide(); } });
    this.win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    return this.win;
  }

  get visible() { return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible()); }

  show() {
    const win = this.create();
    if (process.platform === 'darwin') app.dock?.show();   // a normal window: in the Dock and Cmd-Tab while it is open
    if (win.webContents.isLoading()) win.once('ready-to-show', () => { win.show(); win.focus(); });
    else { win.show(); win.focus(); }
  }

  hide() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  }

  toggle() { if (this.visible && this.win.isFocused()) this.hide(); else this.show(); }

  send(msg) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('senju:event', msg);
  }
}
