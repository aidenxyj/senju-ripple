// Serves the vendored MiniWoB++ pages (html/, MIT, see LICENSE and README.md) for one episode.
//
//   const site = await serveMiniwob({ task: 'click-button', seed: 42, maxSeconds: 300 })
//   site.url       http://127.0.0.1:<port>/miniwob/click-button.html
//   site.reports   [{ raw, reason, utterance }]   one per finished episode, in order
//   site.started   [{ utterance }]                one per page load
//   await site.close()
//
// The task page gets a small script before </body> that does what BrowserGym does when an episode starts:
// seed the RNG, raise core.EPISODE_MAX_TIME (MiniWoB's 10-30 s is for RL agents, not LLM swarms), and call
// core.startEpisodeReal(). When WOB_DONE_GLOBAL turns true it POSTs { raw: WOB_RAW_REWARD_GLOBAL, reason } to /report.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'html');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function episodeScript({ seed, maxSeconds }) {
  return `<script>
(function () {
  var SEED = ${JSON.stringify(seed)}, MAX_MS = ${Math.round(maxSeconds * 1000)};
  function post(path, data) {
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).catch(function () {});
  }
  function start() {
    if (!window.core || !core.cover_div) return setTimeout(start, 20);
    Math.seedrandom(SEED);
    core.EPISODE_MAX_TIME = MAX_MS;
    core.startEpisodeReal();
    post('/started', { utterance: core.getUtterance() });
    var sent = false;
    (function poll() {
      if (sent) return;
      if (WOB_DONE_GLOBAL) { sent = true; post('/report', { raw: WOB_RAW_REWARD_GLOBAL, reason: WOB_REWARD_REASON, utterance: core.getUtterance() }); return; }
      setTimeout(poll, 100);
    })();
  }
  window.addEventListener('load', function () { setTimeout(start, 0); });
})();
</script>`;
}

export async function serveMiniwob({ task, seed = 42, maxSeconds = 300 }) {
  const reports = [];
  const started = [];
  const script = episodeScript({ seed, maxSeconds });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      if (url.pathname === '/report') reports.push({ raw: Number(body.raw), reason: body.reason ?? null, utterance: String(body.utterance ?? '') });
      if (url.pathname === '/started') started.push({ utterance: String(body.utterance ?? '') });
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(302, { location: `/miniwob/${task}.html` }).end();
      return;
    }
    const file = path.normalize(path.join(HTML, decodeURIComponent(url.pathname)));
    if (!file.startsWith(HTML + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    let body = fs.readFileSync(file);
    if (url.pathname === `/miniwob/${task}.html`) body = Buffer.from(body.toString('utf8').replace(/<\/body>/i, `${script}\n</body>`));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/miniwob/${task}.html`,
    reports,
    started,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
