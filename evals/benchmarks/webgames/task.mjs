// WebGames (convergence-ai/webgames, Apache-2.0) as eval tasks. See README.md in this folder for the source and build.
//
//   export default webgamesTask({ id, title, description, solve })
//
// setup() serves the built app (dist/) from 127.0.0.1 on a random port, with index.html for every challenge path
// (it is a single-page app). The agent opens the challenge, solves it, and writes the password the page reveals to
// {workspace}/answer.txt. check() compares that file with the password from the HF dataset (passwords.json).
//
// The stub really plays: it navigates, runs the challenge's `solve` steps, reads the password off the page, and
// writes it. It never uses passwords.json.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const PASSWORDS = JSON.parse(fs.readFileSync(path.join(HERE, 'passwords.json'), 'utf8'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png',
};

// A static server for dist/: files by path, 404 for /api (the app's analytics calls fail quietly), index.html otherwise.
export async function serveApp() {
  const index = fs.readFileSync(path.join(DIST, 'index.html'));
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"offline"}'); }
    const file = path.join(DIST, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(DIST + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (path.extname(p)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
    res.end(index);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

// The revealed password, read off the page. Every challenge shows it after "password:" or "password is:".
const READ_PASSWORD = `() => {
  const m = document.body.innerText.match(/password(?: is)?\\s*:\\s*([A-Za-z0-9_-]+)/i);
  return 'PW<<' + (m ? m[1] : 'NOT FOUND') + '>>';
}`;

export const evaluate = (fn) => ({ name: 'browser__browser_evaluate', input: { function: fn } });
export const click = (selector, element = selector) => ({ name: 'browser__browser_click', input: { element, target: selector } });
export const type = (selector, text, element = selector) => ({ name: 'browser__browser_type', input: { element, target: selector, text } });
export const press = (key) => ({ name: 'browser__browser_press_key', input: { key } });

/**
 * @param {object} o
 * @param {string} o.id           WebGames id, also the page path (webgames-<id> is the task id)
 * @param {string} o.title
 * @param {string} o.description  the challenge's own one-line description
 * @param {Array}  o.solve        stub steps after the page is open: { name, input } or ({ ctx, lastText }) => { name, input }
 */
export function webgamesTask({ id, title, description, solve, timeout = 300, maxSteps = 60 }) {
  if (!PASSWORDS[id]) throw new Error(`webgames: no password for "${id}" in passwords.json`);
  return {
    id: `webgames-${id}`,
    goal: `Open {url} in the browser. It is the WebGames challenge "${title}": ${description}. ` +
      'Solve it. When it is solved, the page shows a secret password. ' +
      'Write exactly that password, and nothing else, to the file {workspace}/answer.txt',
    servers: ['browser', 'files'],
    timeout,
    maxSteps,
    async setup(ctx) {
      ctx.site = await serveApp();
      ctx.url = `${ctx.site.url}${id}`;
    },
    check({ workspace }) {
      const file = path.join(workspace, 'answer.txt');
      if (!fs.existsSync(file)) return { pass: false, detail: 'answer.txt was not written' };
      const got = fs.readFileSync(file, 'utf8').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
      if (got === PASSWORDS[id]) return { pass: true, detail: 'the password is correct' };
      return { pass: false, detail: `answer.txt says ${JSON.stringify(got.slice(0, 60))}, which is not the password` };
    },
    teardown: (ctx) => ctx.site?.close(),
    stub: [
      ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: ctx.url } }),
      ...solve,
      evaluate(READ_PASSWORD),
      ({ ctx, lastText }) => ({
        name: 'files__write_file',
        input: { path: path.join(ctx.workspace, 'answer.txt'), content: `${lastText.match(/PW<<(.*?)>>/)?.[1] ?? 'NOT FOUND'}\n` },
      }),
    ],
  };
}
