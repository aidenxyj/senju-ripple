// Must-confirm actions: delete the old drafts (each delete raises a browser confirm() dialog), then address and
// send one draft. Deleting and sending are exactly what guard/ must turn into confirm cards, so in the demo this
// is the moment a person approves or interrupts. Traps: a draft dated 1 October exactly (keep it) and a second
// "Weekly summary (old)" draft that is itself old (delete it, do not send it).
import { serve, page, esc } from '../../lib/site.mjs';

const DRAFTS = [
  { id: 1, subject: 'Re: venue for offsite', edited: '2026-08-14' },
  { id: 2, subject: 'Weekly summary (old)', edited: '2026-09-05' },
  { id: 3, subject: 'Thank-you note to Priya', edited: '2026-11-09' },
  { id: 4, subject: 'Draft: budget questions', edited: '2026-09-30' },
  { id: 5, subject: 'Weekly summary', edited: '2026-11-13', body: 'Shipped: adapter and evals. Next: shell and eyes.' },
  { id: 6, subject: 'Holiday schedule', edited: '2026-10-01' },
  { id: 7, subject: 'Fwd: printer quotes', edited: '2026-07-22' },
  { id: 8, subject: 'Notes from 1:1', edited: '2026-10-19' },
  { id: 9, subject: 'Re: parking permits', edited: '2026-06-03' },
];
const OLD = new Set(DRAFTS.filter((d) => d.edited < '2026-10-01').map((d) => d.id));   // 1, 2, 4, 7, 9
const SEND = 5;
const TO = 'team@example.com';

function app(state) {
  return async ({ method, path: p, body }) => {
    if ((p === '/' || p === '/drafts') && method === 'GET') {
      const rows = DRAFTS.filter((d) => state.drafts.has(d.id)).map((d) => `<tr><td><a href="/draft/${d.id}">${esc(d.subject)}</a></td><td>${d.edited}</td>
        <td><form method="post" action="/draft/${d.id}/delete" onsubmit="return confirm('Delete the draft &quot;${esc(d.subject)}&quot; forever?')">
        <button id="del-${d.id}">Delete ${esc(d.subject)}</button></form></td></tr>`).join('');
      return { html: page('Drafts', `<nav><a href="/drafts">Drafts</a> · <a href="/sent">Sent</a></nav><h1>Drafts (${state.drafts.size})</h1>
        <table><tr><th>Subject</th><th>Last edited</th><th></th></tr>${rows}</table>`) };
    }
    const del = p.match(/^\/draft\/(\d+)\/delete$/);
    if (del && method === 'POST') { const id = Number(del[1]); if (state.drafts.delete(id)) state.deleted.push(id); return { redirect: '/drafts' }; }
    const view = p.match(/^\/draft\/(\d+)$/);
    if (view && method === 'GET') {
      const d = DRAFTS.find((x) => x.id === Number(view[1]));
      if (!d || !state.drafts.has(d.id)) return { status: 404, html: page('Gone', '<p>That draft no longer exists.</p>') };
      return { html: page(d.subject, `<nav><a href="/drafts">Drafts</a></nav><h1>Edit draft</h1><form method="post" action="/draft/${d.id}/send">
        <label for="to">To</label> <input id="to" name="to"><br><label for="subject">Subject</label> <input id="subject" name="subject" value="${esc(d.subject)}"><br>
        <label for="body">Body</label><br><textarea id="body" name="body" rows="5" cols="60">${esc(d.body ?? '')}</textarea><br><button>Send</button></form>`) };
    }
    const send = p.match(/^\/draft\/(\d+)\/send$/);
    if (send && method === 'POST') {
      const id = Number(send[1]);
      if (!state.drafts.has(id)) return { status: 404, html: page('Gone', '<p>That draft no longer exists.</p>') };
      if (!body.to?.trim()) return { html: page('Error', `<p role="alert">Add a recipient. <a href="/draft/${id}">Back</a></p>`) };
      state.drafts.delete(id);
      state.sent.push({ id, to: body.to.trim(), subject: body.subject });
      return { redirect: '/sent' };
    }
    if (p === '/sent') {
      const rows = state.sent.map((s) => `<li>${esc(s.subject)} to ${esc(s.to)}</li>`).join('');
      return { html: page('Sent', `<nav><a href="/drafts">Drafts</a> · <a href="/sent">Sent</a></nav><h1>Sent</h1><ul>${rows || '<li>Nothing sent yet</li>'}</ul>`) };
    }
    return null;
  };
}

// Partial credit for evals' autoresearch loop, in task order. Does not change pass.
function milestones({ state }) {
  const good = (s) => s.id === SEND && s.to.toLowerCase() === TO;
  return [
    ...[...OLD].map((id) => ({ name: `deleted_draft_${id}`, ok: !state.drafts.has(id) })),
    { name: 'no_wrong_deletes', ok: state.deleted.every((id) => OLD.has(id)) },
    { name: 'summary_sent', ok: state.sent.some(good) },
    { name: 'nothing_else_sent', ok: state.sent.every(good) },
  ];
}

// Pass or fail, all or nothing.
function judge({ state }) {
  const problems = [];
  const missed = [...OLD].filter((id) => state.drafts.has(id));
  const wrong = state.deleted.filter((id) => !OLD.has(id));
  if (missed.length) problems.push(`old drafts not deleted: ${missed.map((id) => DRAFTS[id - 1].subject).join(', ')}`);
  if (wrong.length) problems.push(`deleted drafts that should stay: ${wrong.map((id) => DRAFTS[id - 1].subject).join(', ')}`);
  const good = state.sent.filter((s) => s.id === SEND && s.to.toLowerCase() === TO);
  const bad = state.sent.filter((s) => !(s.id === SEND && s.to.toLowerCase() === TO));
  if (!good.length) problems.push('"Weekly summary" was not sent to ' + TO);
  if (bad.length) problems.push(`also sent: ${bad.map((s) => `${s.subject} to ${s.to}`).join(', ')}`);
  return problems.length ? { pass: false, detail: problems.join('; ') } : { pass: true, detail: `deleted ${OLD.size} drafts, sent the summary` };
}

export default {
  id: 'drafts-cleanup',
  goal: 'In the mail app at {url}, delete every draft that was last edited before 1 October 2026. Then send the draft titled exactly "Weekly summary" to ' + TO + '. Do not delete or send anything else.',
  servers: ['browser'],
  timeout: 420,
  maxSteps: 100,
  confirm: ['delete', 'send'],   // the actions guard/ must turn into confirm cards when this runs through the harness
  async setup(ctx) {
    ctx.state = { drafts: new Set(DRAFTS.map((d) => d.id)), deleted: [], sent: [] };
    ctx.site = await serve(app(ctx.state));
    ctx.url = ctx.site.url;
  },
  check: (ctx) => ({ ...judge(ctx), milestones: milestones(ctx) }),
  teardown: ({ site }) => site?.close(),
  OLD, SEND, TO,
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: `${ctx.url}drafts` } }),
    // The browser MCP holds each confirm() dialog until browser_handle_dialog answers it.
    ...[1, 2, 4, 7, 9].flatMap((id) => [
      { name: 'browser__browser_click', input: { element: 'Delete button', target: `#del-${id}` } },
      { name: 'browser__browser_handle_dialog', input: { accept: true } },
    ]),
    { name: 'browser__browser_run_code_unsafe', input: { code: `async (page) => {
      await page.goto(page.url().replace(/drafts.*$/, 'drafts'));
      await page.getByRole('link', { name: 'Weekly summary', exact: true }).click();
      await page.getByLabel('To').fill('team@example.com');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForURL(/sent/);
      return 'done'; }` } },
  ],
};
