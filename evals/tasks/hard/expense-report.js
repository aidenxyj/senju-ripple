// Long horizon: read 14 emails over 3 inbox pages, pick out the November invoices (one sent twice, plus a quote,
// a credit note and an October invoice as traps), write them to a CSV, then submit an expense claim with the total.
import fs from 'node:fs';
import path from 'node:path';
import { serve, page, esc, money } from '../../lib/site.mjs';

const MAIL = [
  { id: 1, from: 'billing@northwind.test', subject: 'Invoice INV-1029', date: '2026-10-28', body: 'Northwind Paper\nInvoice INV-1029, dated 28 October 2026.\nAmount due: $288.10' },
  { id: 2, from: 'billing@northwind.test', subject: 'Your November invoice', date: '2026-11-02', body: 'Northwind Paper\nInvoice INV-1041, dated 2 November 2026.\nAmount due: $312.40\nThank you for your business.' },
  { id: 3, from: 'accounts@bluebird.test', subject: 'Invoice INV-1043 for cloud hosting', date: '2026-11-03', body: 'Bluebird Cloud\nInvoice number: INV-1043 (2 November 2026)\nTotal: $1,240.00 due in 30 days.' },
  { id: 4, from: 'priya@ourteam.test', subject: 'Team lunch on Friday?', date: '2026-11-04', body: 'Anyone up for tacos? I can book for 12:30.' },
  { id: 5, from: 'events@fernhill.test', subject: 'Quote Q-552 for the December party', date: '2026-11-04', body: 'Fernhill Catering\nThis is a QUOTE, not an invoice. Quote Q-552: $900.00 for 40 guests.' },
  { id: 6, from: 'events@fernhill.test', subject: 'Invoice A-7781', date: '2026-11-05', body: 'Fernhill Catering\nInvoice A-7781 for the 5 November board lunch.\nPlease pay $486.75.' },
  { id: 7, from: 'news@gadgetweekly.test', subject: 'This week in gadgets', date: '2026-11-06', body: 'Ten desk lamps under $50, ranked.' },
  { id: 8, from: 'ops@orbitcourier.test', subject: 'Invoice 2026-118', date: '2026-11-07', body: 'Orbit Courier\nInvoice 2026-118 (7 November 2026), same-day delivery x3.\nAmount: $58.20' },
  { id: 9, from: 'accounts@bluebird.test', subject: 'Credit note CN-12', date: '2026-11-08', body: 'Bluebird Cloud\nCredit note CN-12: we have credited $100.00 to your account. This is not an invoice and needs no payment.' },
  { id: 10, from: 'accounts@bluebird.test', subject: 'Reminder: invoice INV-1043 is unpaid', date: '2026-11-10', body: 'Bluebird Cloud\nFriendly reminder that invoice INV-1043 ($1,240.00) is still open. This is the same invoice we sent on 3 November.' },
  { id: 11, from: 'calendar@ourteam.test', subject: 'Invitation: Q4 planning', date: '2026-11-11', body: 'Q4 planning, Thursday 10:00, room Ada.' },
  { id: 12, from: 'fees@kestrel-legal.test', subject: 'Invoice INV-0937 - contract review', date: '2026-11-12', body: 'Kestrel Legal LLP\nInvoice INV-0937, 12 November 2026.\nProfessional fees: $2,150.00' },
  { id: 13, from: 'sales@lumen.test', subject: 'Lumen Office Supply invoice SR-4410', date: '2026-11-14', body: 'Lumen Office Supply\nInvoice SR-4410 (14 November 2026)\n4 x whiteboard markers, 2 x desk organiser\nTotal due: $97.15' },
  { id: 14, from: 'it@ourteam.test', subject: 'Laptop refresh survey', date: '2026-11-15', body: 'Tell us which laptop you want by Friday.' },
];
const INVOICES = [
  ['Northwind Paper', 'INV-1041', 312.40],
  ['Bluebird Cloud', 'INV-1043', 1240.00],
  ['Fernhill Catering', 'A-7781', 486.75],
  ['Orbit Courier', '2026-118', 58.20],
  ['Kestrel Legal', 'INV-0937', 2150.00],
  ['Lumen Office Supply', 'SR-4410', 97.15],
];
const TOTAL = 4344.50;
const PER_PAGE = 5;

function app(state) {
  return async ({ method, path: p, query, body }) => {
    if (p === '/' || p === '/inbox') {
      const n = Math.max(1, Math.min(3, Number(query.page) || 1));
      const rows = [...MAIL].reverse().slice((n - 1) * PER_PAGE, n * PER_PAGE)
        .map((m) => `<tr><td>${esc(m.from)}</td><td><a href="/message/${m.id}">${esc(m.subject)}</a></td><td>${m.date}</td></tr>`).join('');
      const nav = [n > 1 && `<a href="/inbox?page=${n - 1}">Newer</a>`, `Page ${n} of 3`, n < 3 && `<a href="/inbox?page=${n + 1}">Older</a>`].filter(Boolean).join(' · ');
      return { html: page('Inbox', `<h1>Inbox</h1><p><a href="/claim">New expense claim</a></p><table><tr><th>From</th><th>Subject</th><th>Date</th></tr>${rows}</table><p>${nav}</p>`) };
    }
    const m = p.match(/^\/message\/(\d+)$/);
    if (m) {
      const mail = MAIL.find((x) => x.id === Number(m[1]));
      if (!mail) return null;
      return { html: page(mail.subject, `<p><a href="/inbox">Back to inbox</a></p><h1>${esc(mail.subject)}</h1><p>From ${esc(mail.from)} on ${mail.date}</p><pre>${esc(mail.body)}</pre>`) };
    }
    if (p === '/claim' && method === 'GET') {
      return { html: page('Expense claim', `<h1>New expense claim</h1><form method="post" action="/claim">
        <label for="period">Period</label> <select id="period" name="period"><option>October 2026</option><option>November 2026</option></select><br>
        <label for="count">Number of invoices</label> <input id="count" name="count" type="number"><br>
        <label for="total">Total amount (USD)</label> <input id="total" name="total" type="text"><br>
        <button type="submit">Submit claim</button></form>`) };
    }
    if (p === '/claim' && method === 'POST') {
      state.claims.push(body);
      return { html: page('Claim submitted', '<h1>Claim submitted</h1><p>Finance will review it this week.</p>') };
    }
    return null;
  };
}

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
}

// Partial credit for evals' autoresearch loop, in task order. Does not change pass.
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
function milestones({ workspace, state }) {
  const file = path.join(workspace, 'expenses.csv');
  const exists = fs.existsSync(file);
  const [header, ...rows] = exists ? parseCsv(fs.readFileSync(file, 'utf8')) : [];
  const got = new Map(rows.map((r) => [r[1]?.toUpperCase(), Number(String(r[2]).replace(/[$,]/g, ''))]));
  const claim = state.claims.at(-1);
  const total = Number(String(claim?.total).replace(/[$,]/g, ''));
  return [
    { name: 'csv_exists', ok: exists },
    { name: 'csv_header', ok: header?.map((h) => h.toLowerCase()).join(',') === 'vendor,invoice,amount' },
    ...INVOICES.map(([, inv, amt]) => ({ name: `found_${slug(inv)}`, ok: got.has(inv) && Math.abs(got.get(inv) - amt) <= 0.005 })),
    { name: 'no_extras', ok: exists && rows.length === INVOICES.length && [...got.keys()].every((k) => INVOICES.some((i) => i[1] === k)) },
    { name: 'claim_submitted', ok: Boolean(claim) },
    { name: 'claim_count_correct', ok: Boolean(claim) && claim.period === 'November 2026' && Number(claim.count) === INVOICES.length },
    { name: 'claim_total_correct', ok: Boolean(claim) && Math.abs(total - TOTAL) <= 0.005 },
  ];
}

// Pass or fail, all or nothing.
function judge({ workspace, state }) {
  const problems = [];
  const file = path.join(workspace, 'expenses.csv');
  if (!fs.existsSync(file)) problems.push('expenses.csv was not created');
  else {
    const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8'));
    if (header?.map((h) => h.toLowerCase()).join(',') !== 'vendor,invoice,amount') problems.push(`bad header ${JSON.stringify(header)}`);
    const got = new Map(rows.map((r) => [r[1]?.toUpperCase(), Number(String(r[2]).replace(/[$,]/g, ''))]));
    for (const [, inv, amt] of INVOICES) {
      if (!got.has(inv)) problems.push(`missing ${inv}`);
      else if (Math.abs(got.get(inv) - amt) > 0.005) problems.push(`${inv} amount ${got.get(inv)} should be ${amt}`);
    }
    const extra = [...got.keys()].filter((k) => !INVOICES.some((i) => i[1] === k));
    if (extra.length) problems.push(`should not list ${extra.join(', ')}`);
    if (rows.length !== INVOICES.length) problems.push(`${rows.length} rows, expected ${INVOICES.length}`);
  }
  const claim = state.claims.at(-1);
  if (!claim) problems.push('no claim was submitted');
  else {
    const total = Number(String(claim.total).replace(/[$,]/g, ''));
    if (claim.period !== 'November 2026') problems.push(`claim period ${claim.period}`);
    if (Number(claim.count) !== INVOICES.length) problems.push(`claim count ${claim.count}, expected ${INVOICES.length}`);
    if (!(Math.abs(total - TOTAL) <= 0.005)) problems.push(`claim total ${claim.total}, expected ${TOTAL.toFixed(2)}`);
    if (state.claims.length > 1) problems.push(`claim submitted ${state.claims.length} times`);
  }
  return problems.length ? { pass: false, detail: problems.join('; ') } : { pass: true, detail: `6 invoices, total ${money(TOTAL)}` };
}

export default {
  id: 'expense-report',
  goal: 'The inbox at {url} has three pages of email. Find every invoice dated November 2026. Count each invoice once, even if it was sent more than once, and skip quotes and credit notes. '
    + 'Write {workspace}/expenses.csv with the header line vendor,invoice,amount and one row per invoice (amount as a plain number, for example 312.40). '
    + 'Then submit the expense claim form at {url}claim for the period November 2026, with the number of invoices and their total.',
  servers: ['browser', 'files'],
  timeout: 600,
  maxSteps: 150,
  async setup(ctx) {
    ctx.state = { claims: [] };
    ctx.site = await serve(app(ctx.state));
    ctx.url = ctx.site.url;
  },
  check: (ctx) => ({ ...judge(ctx), milestones: milestones(ctx) }),
  teardown: ({ site }) => site?.close(),
  INVOICES, TOTAL,
  stub: [
    ({ ctx }) => ({ name: 'files__write_file', input: { path: path.join(ctx.workspace, 'expenses.csv'),
      content: ['vendor,invoice,amount', ...INVOICES.map(([v, i, a]) => `${v},${i},${a.toFixed(2)}`)].join('\n') + '\n' } }),
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: `${ctx.url}claim` } }),
    { name: 'browser__browser_run_code_unsafe', input: { code: `async (page) => {
      await page.getByLabel('Period').selectOption('November 2026');
      await page.getByLabel('Number of invoices').fill('6');
      await page.getByLabel('Total amount (USD)').fill('4344.50');
      await page.getByRole('button', { name: 'Submit claim' }).click();
      return await page.title(); }` } },
  ],
};
