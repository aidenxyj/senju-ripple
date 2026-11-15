// A tiny local web server for browser tasks. Every request is logged in `site.requests`, so checkers can
// tell what the agent did (and did not do), not only where it ended up.
//
//   const site = await serve(async (req) => ({ html: '<h1>hi</h1>' }));   // or { json }, { redirect }, { status, text }
//   site.url   http://127.0.0.1:<port>/
//   await site.close();
//
// The handler gets { method, path, query, params, body, cookies }: query keeps the last value of each key,
// params is the URLSearchParams (for repeated keys), body is the parsed form or JSON of a POST.
import http from 'node:http';

export async function serve(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    if (raw) {
      try { body = /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); }
      catch { body = { _raw: raw }; }
    }
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
    const r = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), params: url.searchParams, body, cookies };
    requests.push({ method: r.method, path: r.path, query: r.query, body: r.body });
    let out;
    try { out = (await handler(r)) ?? { status: 404, text: 'not found' }; }
    catch (err) { out = { status: 500, text: String(err?.message ?? err) }; }
    const headers = { 'cache-control': 'no-store', ...(out.headers ?? {}) };
    if (out.cookie) headers['set-cookie'] = out.cookie;
    if (out.redirect) { res.writeHead(303, { ...headers, location: out.redirect }); return res.end(); }
    if (out.json !== undefined) { res.writeHead(out.status ?? 200, { ...headers, 'content-type': 'application/json' }); return res.end(JSON.stringify(out.json)); }
    if (out.html !== undefined) { res.writeHead(out.status ?? 200, { ...headers, 'content-type': 'text/html; charset=utf-8' }); return res.end(out.html); }
    res.writeHead(out.status ?? 200, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
    res.end(out.text ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const page = (title, body, head = '') => `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;margin:24px;max-width:900px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left}</style>
${head}</head><body>${body}</body></html>`;

export const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
