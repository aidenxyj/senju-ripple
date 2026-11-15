// Browser: fill in and submit a sign-up form on a local test page. The page records what was submitted.
import http from 'node:http';

const NAME = 'Ada Lovelace';
const EMAIL = 'ada@example.com';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Join the Analytical Society</title></head>
<body>
  <h1>Join the Analytical Society</h1>
  <p>Members get the monthly newsletter.</p>
  <form method="post" action="/signup">
    <label for="name">Full name</label> <input id="name" name="name" type="text"><br>
    <label for="email">Email</label> <input id="email" name="email" type="email"><br>
    <label for="plan">Plan</label>
    <select id="plan" name="plan"><option>Free</option><option>Patron</option></select><br>
    <button id="submit" type="submit">Sign up</button>
  </form>
</body></html>`;

export default {
  id: 'web-form',
  goal: `Open {url} in the browser, fill in the sign-up form with the name "${NAME}" and the email "${EMAIL}", leave the plan as Free, and submit it.`,
  servers: ['browser'],
  timeout: 240,
  setup(ctx) {
    ctx.submissions = [];
    ctx.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/signup') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          ctx.submissions.push(Object.fromEntries(new URLSearchParams(body)));
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><title>Welcome</title><h1>Thanks for signing up!</h1>');
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    return new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', () => {
      ctx.url = `http://127.0.0.1:${ctx.server.address().port}/`;
      resolve();
    }));
  },
  check({ submissions }) {
    if (submissions.length === 0) return { pass: false, detail: 'the form was never submitted' };
    const ok = submissions.find((s) => s.name?.trim() === NAME && s.email?.trim() === EMAIL && s.plan === 'Free');
    if (!ok) return { pass: false, detail: `wrong submission: ${JSON.stringify(submissions.at(-1))}` };
    return { pass: true, detail: `submitted ${submissions.length === 1 ? 'once' : `${submissions.length} times`}` };
  },
  teardown({ server }) {
    server?.closeAllConnections?.();
    return new Promise((r) => (server ? server.close(() => r()) : r()));
  },
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: ctx.url } }),
    { name: 'browser__browser_type', input: { element: 'Full name field', target: '#name', text: NAME } },
    { name: 'browser__browser_type', input: { element: 'Email field', target: '#email', text: EMAIL } },
    { name: 'browser__browser_click', input: { element: 'Sign up button', target: '#submit' } },
  ],
};
