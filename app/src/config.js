// Where things live.
// ROOT is the app's own files (code, default config). dataDir() is where the user's settings,
// traces and skills go: the project folder when run from source, the app's data folder when
// installed (the installed app sets SWARM_DATA_DIR before anything is loaded).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = () => process.env.SWARM_DATA_DIR || ROOT;

export function loadEnv() {
  const file = path.join(dataDir(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// The user's config if they have one, otherwise the default that ships with the app.
// An installed app copies the default into the data folder on first run, so it can be edited.
export function loadConfig() {
  const mine = path.join(dataDir(), 'swarm.config.json');
  const shipped = path.join(ROOT, 'swarm.config.json');
  if (!fs.existsSync(mine) && mine !== shipped) {
    try { fs.mkdirSync(dataDir(), { recursive: true }); fs.copyFileSync(shipped, mine); } catch { /* read-only location: use the default */ }
  }
  const config = JSON.parse(fs.readFileSync(fs.existsSync(mine) ? mine : shipped, 'utf8'));
  config.servers ??= {};
  return config;
}

// Folder the agents share for files. Created on first run.
// Where team mode connects unless swarm.config.json names another server under "cloud".
// The project's hosted team server (see fly.toml). Point "cloud" at your own to self-host.
export const DEFAULT_HUB = 'https://senju-ripple-hub.fly.dev';

export function ensureWorkspace() {
  // The app used to be called Cursor Swarm. A workspace from then keeps working until it is renamed.
  const old = path.join(os.homedir(), 'CursorSwarm');
  const dir = path.join(os.homedir(), 'Senju');
  if (fs.existsSync(old) && !fs.existsSync(dir)) return old;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
