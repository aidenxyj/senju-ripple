// Careful repeated edits: 48 contacts, 10 per page, sorted by id so duplicates sit on different pages.
// Merge every group of contacts that share an email (ignoring case), keeping the most recently updated record.
// Traps: two people share a name but not an email (must not merge), and one group has three records.
import { serve, page, esc } from '../../lib/site.mjs';

const NAMES = ['Ava Chen', 'Ben Okoro', 'Chloe Martin', 'Dev Patel', 'Ella Rossi', 'Finn Larsen', 'Grace Liu', 'Hugo Blanc', 'Isla Murphy',
  'Jamal Wright', 'Kira Sato', 'Leo Fischer', 'Mia Novak', 'Noah Kaplan', 'Olivia Reyes', 'Pablo Ortiz', 'Quinn Hale', 'Ruby Shah',
  'Sam Torres', 'Tess Kowalski', 'Umar Siddiqui', 'Vera Ivanova', 'Will Becker', 'Xena Park', 'Yara Haddad', 'Zane Moore', 'Alma Nyberg',
  'Bruno Costa', 'Cora Lindqvist', 'Dario Bellini', 'Edie Walsh', 'Femi Adebayo', 'Gwen Price', 'Hiro Tanaka', 'Ida Berg', 'Jon Smith',
  'Maria Garcia', 'Maria Garcia'];
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay'];
function seed() {
  const contacts = NAMES.map((name, i) => {
    const company = COMPANIES[i % COMPANIES.length];
    const local = name.toLowerCase().replace(/[^a-z ]/g, '').replace(' ', '.');
    return { id: i + 1, name, company, email: `${local}@${company.toLowerCase()}.test`, updated: `2026-0${1 + (i % 9)}-${String(10 + (i % 18)).padStart(2, '0')}` };
  });
  // The two Maria Garcias are different people (different companies and emails). Keep them apart.
  // Each duplicate copies an existing record's email with different capitalisation.
  const title = (e) => e.replace(/(^|[.@])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  const upperLocal = (e) => e.replace(/^[^@]+/, (l) => l.toUpperCase());
  const upperDomain = (e) => e.replace(/@.+$/, (d) => d.toUpperCase());
  const same = (e) => e;
  const dups = [
    // [copy of id, name on the copy, email variant, last updated]
    [36, 'Jonathan Smith', title, '2026-10-02'],
    [36, 'J. Smith', upperDomain, '2026-08-30'],
    [3, 'Chloe Martin-Hayes', same, '2026-11-01'],
    [11, 'Kira Sato', title, '2026-01-05'],
    [20, 'Tess Kowalski (Globex)', same, '2026-09-30'],
    [27, 'Alma Nyberg', upperLocal, '2026-02-02'],
    [8, 'Hugo Blanc', same, '2026-12-01'],
    [31, 'Edie Walsh', title, '2026-05-15'],
    [15, 'Olivia Reyes', same, '2026-07-07'],
    [24, 'Xena Park', same, '2026-03-03'],
  ];
  let id = contacts.length;
  for (const [of, name, variant, updated] of dups) {
    const base = contacts[of - 1];
    contacts.push({ id: ++id, name, company: base.company, email: variant(base.email), updated });
  }
  return contacts;
}
// Expected survivors: for each email group, the record with the latest `updated`.
export function expectedIds(contacts) {
  const groups = new Map();
  for (const c of contacts) { const k = c.email.toLowerCase(); groups.set(k, [...(groups.get(k) ?? []), c]); }
  return new Set([...groups.values()].map((g) => g.reduce((a, b) => (b.updated > a.updated ? b : a)).id));
}

function app(state) {
  return async ({ method, path: p, query, params, body }) => {
    if ((p === '/' || p === '/contacts') && method === 'GET') {
      const per = [10, 25, 50].includes(Number(query.per)) ? Number(query.per) : 10;
      const sort = ['id', 'name', 'email', 'updated'].includes(query.sort) ? query.sort : 'id';
      const all = [...state.contacts.values()].sort((a, b) => String(a[sort]).toLowerCase() < String(b[sort]).toLowerCase() ? -1 : String(a[sort]).toLowerCase() > String(b[sort]).toLowerCase() ? 1 : a.id - b.id);
      const pages = Math.max(1, Math.ceil(all.length / per));
      const n = Math.min(pages, Math.max(1, Number(query.page) || 1));
      const link = (o) => `/contacts?${new URLSearchParams({ per, sort, page: n, ...o })}`;
      const rows = all.slice((n - 1) * per, n * per).map((c) => `<tr><td><input type="checkbox" name="ids" value="${c.id}" aria-label="Select ${esc(c.name)} (id ${c.id})"></td>
        <td>${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.company)}</td><td>${esc(c.email)}</td><td>${c.updated}</td></tr>`).join('');
      const sorts = ['id', 'name', 'email', 'updated'].map((s) => `<a href="${link({ sort: s, page: 1 })}">Sort by ${s}</a>`).join(' · ');
      const pers = [10, 25, 50].map((x) => `<a href="${link({ per: x, page: 1 })}">${x} per page</a>`).join(' · ');
      const nav = [n > 1 && `<a href="${link({ page: n - 1 })}">Previous page</a>`, `Page ${n} of ${pages}`, n < pages && `<a href="${link({ page: n + 1 })}">Next page</a>`].filter(Boolean).join(' · ');
      return { html: page('Contacts', `<h1>Contacts (${all.length})</h1><p>${sorts}</p><p>${pers}</p>
        <form method="get" action="/merge"><table><tr><th></th><th>Id</th><th>Name</th><th>Company</th><th>Email</th><th>Last updated</th></tr>${rows}</table>
        <button>Merge selected</button></form><p>${nav}</p>`) };
    }
    if (p === '/merge' && method === 'GET') {
      const ids = params.getAll('ids').map(Number).filter((id) => state.contacts.has(id));
      if (ids.length < 2) return { html: page('Merge', '<p role="alert">Select at least two contacts to merge. <a href="/contacts">Back</a></p>') };
      const opts = ids.map((id) => { const c = state.contacts.get(id);
        return `<li><input type="radio" name="keep" value="${id}" id="k${id}"> <label for="k${id}">Keep ${esc(c.name)} (id ${id}, ${esc(c.email)}, updated ${c.updated})</label></li>`; }).join('');
      return { html: page('Merge contacts', `<h1>Merge ${ids.length} contacts</h1><p>The others will be deleted.</p>
        <form method="post" action="/merge"><input type="hidden" name="ids" value="${ids.join(',')}"><ul>${opts}</ul><button>Merge</button></form>
        <p><a href="/contacts">Cancel</a></p>`) };
    }
    if (p === '/merge' && method === 'POST') {
      const ids = String(body.ids ?? '').split(',').map(Number).filter((id) => state.contacts.has(id));
      const keep = Number(body.keep);
      if (ids.length < 2 || !ids.includes(keep)) return { html: page('Merge', '<p role="alert">Pick at least two contacts and which one to keep. <a href="/contacts">Back</a></p>') };
      for (const id of ids) if (id !== keep) state.contacts.delete(id);
      state.merges.push({ keep, ids });
      return { redirect: '/contacts' };
    }
    return null;
  };
}

// Partial credit for evals' autoresearch loop: one milestone per duplicate group (merged_<email local part>,
// ok when only its newest record is left), then no_wrong_deletions. Does not change pass.
const GROUPS = (() => {
  const by = new Map();
  for (const c of seed()) { const k = c.email.toLowerCase(); by.set(k, [...(by.get(k) ?? []), c.id]); }
  return [...by].filter(([, ids]) => ids.length > 1).map(([email, ids]) => ({ name: `merged_${email.split('@')[0].replace(/[^a-z0-9]+/g, '_')}`, ids }));
})();
function milestones({ state }) {
  const left = new Set(state.contacts.keys());
  return [
    ...GROUPS.map((g) => ({ name: g.name, ok: g.ids.filter((id) => left.has(id)).length === 1 && g.ids.some((id) => left.has(id) && state.expected.has(id)) })),
    { name: 'no_wrong_deletions', ok: [...state.expected].every((id) => left.has(id)) },
  ];
}

// Pass or fail, all or nothing.
function judge({ state }) {
  const left = new Set(state.contacts.keys());
  const wrongDeleted = [...state.expected].filter((id) => !left.has(id));
  const notMerged = [...left].filter((id) => !state.expected.has(id));
  const problems = [];
  if (wrongDeleted.length) problems.push(`deleted records that should have been kept: ${wrongDeleted.join(', ')}`);
  if (notMerged.length) problems.push(`duplicates still present: ${notMerged.join(', ')}`);
  return problems.length ? { pass: false, detail: problems.join('; ') } : { pass: true, detail: `${state.merges.length} merges, ${left.size} contacts left` };
}

export default {
  id: 'crm-dedupe',
  goal: 'The contacts admin at {url} has duplicate records. Two records are duplicates when they have the same email address, ignoring upper and lower case. '
    + 'Merge every group of duplicates, keeping in each group the record with the most recent "last updated" date. Do not merge records that only share a name.',
  servers: ['browser'],
  timeout: 600,
  maxSteps: 150,
  async setup(ctx) {
    const contacts = seed();
    ctx.state = { contacts: new Map(contacts.map((c) => [c.id, c])), merges: [], expected: expectedIds(contacts) };
    ctx.site = await serve(app(ctx.state));
    ctx.url = ctx.site.url;
  },
  check: (ctx) => ({ ...judge(ctx), milestones: milestones(ctx) }),
  teardown: ({ site }) => site?.close(),
  seed,
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: `${ctx.url}contacts?per=50&sort=email` } }),
    { name: 'browser__browser_evaluate', input: { function: `async () => {
      const rows = [...document.querySelectorAll('tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent.trim()));
      const groups = {};
      for (const r of rows) (groups[r[4].toLowerCase()] ??= []).push({ id: r[1], updated: r[5] });
      let n = 0;
      for (const g of Object.values(groups)) {
        if (g.length < 2) continue;
        const keep = g.reduce((a, b) => (b.updated > a.updated ? b : a)).id;
        await fetch('/merge', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ids: g.map((x) => x.id).join(','), keep }) });
        n++;
      }
      return n + ' merges'; }` } },
  ],
};
