// A hostile but accessible clinic site: a cookie wall that blocks every page, a newsletter pop-up, a doctor list
// that loads 8 at a time behind "Show more", a decoy doctor with almost the same name, random element ids on every
// load, a custom month-by-month date picker and a full time slot. Book one exact appointment.
import { serve, page, esc } from '../../lib/site.mjs';

const SPECIALTIES = ['Cardiology', 'Dermatology', 'Pediatrics', 'Neurology', 'Orthopedics'];
const FIRST = ['Lena', 'Marco', 'Yuki', 'Samuel', 'Ines', 'Tariq', 'Hana', 'Felix', 'Rosa', 'Daniel'];
const LAST = ['Brandt', 'Costa', 'Ito', 'Mensah', 'Novak', 'Haddad', 'Kim', 'Weber', 'Silva', 'Adeyemi'];
const DOCTORS = Array.from({ length: 40 }, (_, i) => ({
  slug: `d${i + 1}`, name: `Dr. ${FIRST[i % 10]} ${LAST[(i * 3 + 1) % 10]}`, specialty: SPECIALTIES[i % 5],
}));
DOCTORS[18] = { slug: 'd19', name: 'Dr. Amara Okafor-Reid', specialty: 'Dermatology' };   // decoy, shown in batch 3
DOCTORS[30] = { slug: 'd31', name: 'Dr. Amara Okafor', specialty: 'Dermatology' };        // the one, shown in batch 4
const TARGET = { doctor: 'd31', date: '2026-12-03', time: '14:30' };
const SLOTS = ['09:00', '09:30', '11:00', '14:00', '14:30', '16:00'];
const FULL = new Set(['2026-12-03 14:00', '2026-12-03 16:00', '2026-11-20 14:30']);

const rid = () => 'x' + Math.random().toString(36).slice(2, 8);

const COOKIE_WALL = `<div role="dialog" aria-modal="true" aria-label="Cookie consent" id="${'%ID%'}"
  style="position:fixed;inset:0;background:rgba(0,0,0,.85);color:#fff;display:flex;align-items:center;justify-content:center;z-index:99">
  <div><h2>We value your privacy</h2><p>Choose your cookie settings to continue.</p>
  <button onclick="document.cookie='consent=all;path=/';location.reload()">Accept all</button>
  <button onclick="document.cookie='consent=essential;path=/';location.reload()">Only essential</button></div></div>`;

function shell(title, body, cookies, script = '') {
  const wall = cookies.consent ? '' : COOKIE_WALL.replace('%ID%', rid());
  return page(title, `<header><a href="/">Sunrise Clinic</a> · <a href="/doctors">Find a doctor</a></header>${body}${wall}<script>${script}</script>`);
}

function app(state) {
  return async ({ method, path: p, query, body, cookies }) => {
    if (cookies.consent) state.consented = true;   // for the passed_cookie_wall milestone
    if (p === '/' && method === 'GET') {
      return { html: shell('Sunrise Clinic', `<h1>Sunrise Clinic</h1><p>Book online in minutes.</p><p><a href="/doctors">Find a doctor</a></p>`, cookies) };
    }
    if (p === '/doctors' && method === 'GET') {
      const listId = rid();
      return { html: shell('Find a doctor', `<h1>Our doctors</h1><ul id="${listId}"></ul><button id="${rid()}" data-more>Show more</button>
        <div id="nl" role="dialog" aria-label="Newsletter" hidden style="position:fixed;top:20%;left:20%;right:20%;background:#fff;border:2px solid #333;padding:16px;z-index:50">
          <h2>Get health tips every week</h2><input aria-label="Your email"><button>Subscribe</button> <button data-close>No thanks</button></div>`, cookies, `
        let offset = 0;
        const list = document.getElementById(${JSON.stringify(listId)});
        const more = document.querySelector('[data-more]');
        async function load() {
          const r = await fetch('/api/doctors?offset=' + offset); const d = await r.json();
          for (const doc of d.doctors) { const li = document.createElement('li');
            li.innerHTML = '<a href="/doctor/' + doc.slug + '">' + doc.name + '</a> (' + doc.specialty + ')'; list.appendChild(li); }
          offset += d.doctors.length; if (!d.more) more.remove();
        }
        more.onclick = load; load();
        setTimeout(() => { document.getElementById('nl').hidden = false; }, 1500);
        document.querySelector('[data-close]').onclick = () => { document.getElementById('nl').hidden = true; };`) };
    }
    if (p === '/api/doctors') {
      const off = Number(query.offset) || 0;
      return { json: { doctors: DOCTORS.slice(off, off + 8), more: off + 8 < DOCTORS.length } };
    }
    if (p === '/api/slots') {
      return { json: { slots: SLOTS.map((t) => ({ time: t, full: FULL.has(`${query.date} ${t}`) })) } };
    }
    const m = p.match(/^\/doctor\/(d\d+)$/);
    if (m && method === 'GET') {
      const doc = DOCTORS.find((d) => d.slug === m[1]);
      if (!doc) return null;
      return { html: shell(doc.name, `<h1>${esc(doc.name)}</h1><p>${esc(doc.specialty)}</p>
        <h2>Pick a date</h2><div><button data-prev>Previous month</button> <strong data-month aria-live="polite"></strong> <button data-next>Next month</button></div>
        <div data-days role="group" aria-label="Days"></div>
        <h2>Pick a time</h2><div data-slots role="group" aria-label="Times"><p>Choose a date first.</p></div>
        <p aria-live="polite" data-picked>Nothing picked yet.</p>
        <h2>Your details</h2>
        <label for="${'pn'}">Patient name</label> <input id="pn"><br>
        <label for="rs">Reason for visit</label> <textarea id="rs"></textarea><br>
        <input type="checkbox" id="ag"> <label for="ag">I agree to the cancellation policy</label><br>
        <button data-book>Book appointment</button> <p role="alert" data-msg></p>`, cookies, `
        const doctor = ${JSON.stringify(doc.slug)};
        const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        let y = 2026, mo = 10, date = null, time = null;
        const $ = (s) => document.querySelector(s);
        function picked() { $('[data-picked]').textContent = 'Picked: ' + (date ?? 'no date') + ' at ' + (time ?? 'no time'); }
        function days() {
          $('[data-month]').textContent = months[mo] + ' ' + y;
          const n = new Date(y, mo + 1, 0).getDate(); const box = $('[data-days]'); box.innerHTML = '';
          for (let d = 1; d <= n; d++) { const b = document.createElement('button'); b.textContent = d;
            const wd = new Date(y, mo, d).getDay(); if (wd === 0 || wd === 6) b.disabled = true;
            b.onclick = () => { date = y + '-' + String(mo + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'); time = null; picked(); slots(); };
            box.appendChild(b); }
        }
        async function slots() {
          const r = await fetch('/api/slots?date=' + date); const d = await r.json(); const box = $('[data-slots]'); box.innerHTML = '';
          for (const s of d.slots) { const b = document.createElement('button'); b.textContent = s.time + (s.full ? ' (full)' : '');
            b.disabled = s.full; b.onclick = () => { time = s.time; picked(); }; box.appendChild(b); }
        }
        $('[data-prev]').onclick = () => { if (y === 2026 && mo === 10) return; mo--; if (mo < 0) { mo = 11; y--; } days(); };
        $('[data-next]').onclick = () => { mo++; if (mo > 11) { mo = 0; y++; } days(); };
        $('[data-book]').onclick = async () => {
          const r = await fetch('/api/book', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ doctor, date, time, patient: $('#pn').value, reason: $('#rs').value, agreed: $('#ag').checked }) });
          const d = await r.json(); $('[data-msg]').textContent = d.ok ? 'Booked! Reference ' + d.ref : 'Error: ' + d.error;
        };
        days();`) };
    }
    if (p === '/api/book' && method === 'POST') {
      const b = body;
      if (!b.date || !b.time) return { json: { ok: false, error: 'pick a date and a time' } };
      if (!b.patient?.trim()) return { json: { ok: false, error: 'patient name is required' } };
      if (!b.agreed) return { json: { ok: false, error: 'you must agree to the cancellation policy' } };
      if (FULL.has(`${b.date} ${b.time}`)) return { json: { ok: false, error: 'that slot is full' } };
      const ref = 'SC-' + (1000 + state.bookings.length);
      state.bookings.push({ doctor: b.doctor, date: b.date, time: b.time, patient: b.patient.trim(), ref });
      return { json: { ok: true, ref } };
    }
    return null;
  };
}

// Partial credit for evals' autoresearch loop, in task order. Does not change pass.
function milestones({ state, site }) {
  const reqs = site?.requests ?? [];
  const ok = (b) => b.doctor === TARGET.doctor && b.date === TARGET.date && b.time === TARGET.time && /ada lovelace/i.test(b.patient);
  return [
    { name: 'passed_cookie_wall', ok: Boolean(state.consented) || state.bookings.length > 0 },
    { name: 'loaded_beyond_first_batch', ok: reqs.some((r) => r.path === '/api/doctors' && Number(r.query.offset) > 0) },
    { name: 'opened_target_doctor', ok: reqs.some((r) => r.method === 'GET' && r.path === `/doctor/${TARGET.doctor}`) },
    { name: 'picked_target_date', ok: reqs.some((r) => r.path === '/api/slots' && r.query.date === TARGET.date) },
    { name: 'booked_any', ok: state.bookings.length > 0 },
    { name: 'booked_correct', ok: state.bookings.some(ok) },
  ];
}

// Pass or fail, all or nothing.
function judge({ state }) {
  const { bookings } = state;
  if (bookings.length === 0) return { pass: false, detail: 'nothing was booked' };
  const ok = (b) => b.doctor === TARGET.doctor && b.date === TARGET.date && b.time === TARGET.time && /ada lovelace/i.test(b.patient);
  if (bookings.length > 1) return { pass: false, detail: `${bookings.length} bookings: ${bookings.map((b) => `${b.doctor} ${b.date} ${b.time}`).join('; ')}` };
  const b = bookings[0];
  if (b.doctor === 'd19') return { pass: false, detail: 'booked the decoy, Dr. Amara Okafor-Reid' };
  if (!ok(b)) return { pass: false, detail: `booked ${b.doctor} on ${b.date} at ${b.time} for ${b.patient}` };
  return { pass: true, detail: `booked ${b.ref}` };
}

export default {
  id: 'hostile-ui',
  goal: 'On the Sunrise Clinic website at {url}, book an appointment with Dr. Amara Okafor (Dermatology) on Thursday 3 December 2026 at 14:30 for the patient Ada Lovelace, reason "skin check". '
    + 'Book exactly one appointment.',
  servers: ['browser'],
  timeout: 480,
  maxSteps: 120,
  async setup(ctx) {
    ctx.state = { bookings: [] };
    ctx.site = await serve(app(ctx.state));
    ctx.url = ctx.site.url;
  },
  check: (ctx) => ({ ...judge(ctx), milestones: milestones(ctx) }),
  teardown: ({ site }) => site?.close(),
  TARGET,
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: `${ctx.url}doctor/d31` } }),
    { name: 'browser__browser_run_code_unsafe', input: { code: `async (page) => {
      await page.getByRole('button', { name: 'Accept all' }).click();
      await page.waitForLoadState();
      await page.getByRole('button', { name: 'Next month' }).click();
      await page.getByRole('group', { name: 'Days' }).getByRole('button', { name: '3', exact: true }).click();
      await page.getByRole('button', { name: '14:30', exact: true }).click();
      await page.getByLabel('Patient name').fill('Ada Lovelace');
      await page.getByLabel('Reason for visit').fill('skin check');
      await page.getByLabel('I agree to the cancellation policy').check();
      await page.getByRole('button', { name: 'Book appointment' }).click();
      await page.getByText('Booked!').waitFor();
      return 'booked'; }` } },
  ],
};
