// OpenApps-style apps: a calendar, a to-do list and a messenger on one local site, written from scratch for our
// evals (OpenApps itself is CC BY-NC and Python). Server-rendered, plain forms that POST and redirect, labelled
// inputs and buttons, so a text-only agent can use them through the accessibility tree.
//
//   const apps = await startOpenApps();   // apps.url, apps.state { events, todos, threads }, apps.close()
//   apps.seed                             // the starting state, for collateral-damage checks
//
// State is a plain object the checkers read directly.
import { serve, page, esc } from '../../lib/site.mjs';

export const SEED = {
  events: [
    { id: 1, title: 'Team standup', date: '2025-07-07', location: 'Room 2B', description: '' },
    { id: 2, title: 'WACV 2026 Abstract Deadline', date: '2025-07-11', location: '', description: 'Submit the abstract on OpenReview' },
    { id: 3, title: 'Dentist appointment', date: '2025-07-15', location: 'Main St Dental', description: '' },
    { id: 4, title: 'WACV 2026 Paper Deadline', date: '2025-07-18', location: '', description: 'Full paper due' },
    { id: 5, title: 'Lunch with Alice', date: '2025-07-22', location: 'Cafe Lumen', description: '' },
  ],
  todos: [
    { id: 1, name: 'Buy groceries', done: false },
    { id: 2, name: 'Water plants', done: false },
    { id: 3, name: 'Call Aunt Lisa', done: false },
    { id: 4, name: 'Pay electricity bill', done: true },
    { id: 5, name: 'Book flights for the conference', done: false },
  ],
  contacts: ['Alice', 'Bob', 'Carol', 'Dennis'],
  threads: {
    Alice: [{ from: 'Alice', text: 'Are you coming to lunch on the 22nd?' }],
    Bob: [{ from: 'Bob', text: 'Hey! Long time no see.' }],
    Carol: [],
    Dennis: [{ from: 'me', text: 'See you in April.' }],
  },
};

// What each contact says back when you message them.
export const REPLIES = {
  Bob: "Yes, let's play on Saturday!",
  Alice: 'Yes, see you there!',
  Carol: 'Thanks, got it.',
  Dennis: 'Sounds good.',
};

const clone = (x) => JSON.parse(JSON.stringify(x));

// Accept 2026-04-01, 2026/4/1, 04/01/2026 and "April 1, 2026". -> 'YYYY-MM-DD' or null
export function normDate(s) {
  const t = String(s ?? '').trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return fmt(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return fmt(+m[3], +m[1], +m[2]);
  const d = new Date(`${t.replace(/(\d)(st|nd|rd|th)\b/, '$1')} 12:00`);
  return Number.isNaN(d.getTime()) ? null : fmt(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
const fmt = (y, mo, d) => (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);

const NAV = '<nav aria-label="Apps"><a href="/">Home</a> · <a href="/calendar">Calendar</a> · <a href="/todo">To-do</a> · <a href="/messenger">Messenger</a></nav>';

export async function startOpenApps() {
  const state = clone(SEED);
  let nextEvent = 100;
  let nextTodo = 100;
  const notice = { text: '' };
  const flash = () => { const t = notice.text; notice.text = ''; return t ? `<p role="status">${esc(t)}</p>` : ''; };

  const site = await serve(async ({ method, path: p, query, body }) => {
    if (method === 'GET' && p === '/') {
      return { html: page('My Apps', `<h1>My Apps</h1>${NAV}<ul>
        <li><a href="/calendar">Calendar</a>: ${state.events.length} events</li>
        <li><a href="/todo">To-do</a>: ${state.todos.filter((t) => !t.done).length} open items</li>
        <li><a href="/messenger">Messenger</a>: ${state.contacts.length} contacts</li></ul>`) };
    }

    // ---- Calendar ----
    if (method === 'GET' && p === '/calendar') {
      const rows = [...state.events].sort((a, b) => a.date.localeCompare(b.date)).map((e) => `<tr>
        <td>${esc(e.date)}</td><td>${esc(e.title)}</td><td>${esc(e.location)}</td><td>${esc(e.description)}</td>
        <td><form method="post" action="/calendar/delete"><input type="hidden" name="id" value="${e.id}">
        <button type="submit" id="delete-event-${e.id}" aria-label="Delete ${esc(e.title)}">Delete</button></form></td></tr>`).join('');
      return { html: page('Calendar', `<h1>Calendar</h1>${NAV}${flash()}
        <h2>Events</h2><table><thead><tr><th>Date</th><th>Title</th><th>Location</th><th>Description</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No events</td></tr>'}</tbody></table>
        <h2>Add an event</h2>
        <form method="post" action="/calendar/add">
          <p><label for="title">Title</label> <input id="title" name="title" required></p>
          <p><label for="date">Date</label> <input id="date" name="date" placeholder="YYYY-MM-DD" required></p>
          <p><label for="location">Location</label> <input id="location" name="location"></p>
          <p><label for="description">Description</label> <input id="description" name="description"></p>
          <p><button type="submit" id="add-event">Add event</button></p>
        </form>`) };
    }
    if (method === 'POST' && p === '/calendar/add') {
      const title = String(body.title ?? '').trim();
      const date = normDate(body.date);
      if (!title || !date) { notice.text = `Not added: ${!title ? 'the title is empty' : `"${body.date ?? ''}" is not a date (use YYYY-MM-DD)`}.`; return { redirect: '/calendar' }; }
      state.events.push({ id: nextEvent++, title, date, location: String(body.location ?? '').trim(), description: String(body.description ?? '').trim() });
      notice.text = `Added "${title}" on ${date}.`;
      return { redirect: '/calendar' };
    }
    if (method === 'POST' && p === '/calendar/delete') {
      const e = state.events.find((x) => String(x.id) === String(body.id));
      state.events = state.events.filter((x) => x !== e);
      notice.text = e ? `Deleted "${e.title}".` : 'That event was already gone.';
      return { redirect: '/calendar' };
    }

    // ---- To-do ----
    if (method === 'GET' && p === '/todo') {
      const items = state.todos.map((t) => `<li>${t.done ? '✅ <s>' : '⬜ '}${esc(t.name)}${t.done ? '</s> (done)' : ''}
        <form method="post" action="/todo/toggle" style="display:inline"><input type="hidden" name="id" value="${t.id}">
        <button type="submit" id="toggle-todo-${t.id}" aria-label="${t.done ? 'Mark not done' : 'Mark done'}: ${esc(t.name)}">${t.done ? 'Mark not done' : 'Mark done'}</button></form>
        <form method="post" action="/todo/delete" style="display:inline"><input type="hidden" name="id" value="${t.id}">
        <button type="submit" id="delete-todo-${t.id}" aria-label="Delete ${esc(t.name)}">Delete</button></form></li>`).join('');
      return { html: page('To-do', `<h1>To-do</h1>${NAV}${flash()}<ul aria-label="To-do items">${items || '<li>Nothing to do</li>'}</ul>
        <h2>Add a to-do</h2>
        <form method="post" action="/todo/add"><label for="todo-name">New to-do</label> <input id="todo-name" name="name" required>
        <button type="submit" id="add-todo">Add</button></form>`) };
    }
    if (method === 'POST' && p === '/todo/add') {
      const name = String(body.name ?? '').trim();
      if (!name) { notice.text = 'Not added: the to-do is empty.'; return { redirect: '/todo' }; }
      state.todos.push({ id: nextTodo++, name, done: false });
      notice.text = `Added "${name}".`;
      return { redirect: '/todo' };
    }
    if (method === 'POST' && (p === '/todo/toggle' || p === '/todo/delete')) {
      const t = state.todos.find((x) => String(x.id) === String(body.id));
      if (!t) notice.text = 'That item is gone.';
      else if (p === '/todo/toggle') { t.done = !t.done; notice.text = `"${t.name}" is now ${t.done ? 'done' : 'not done'}.`; }
      else { state.todos = state.todos.filter((x) => x !== t); notice.text = `Deleted "${t.name}".`; }
      return { redirect: '/todo' };
    }

    // ---- Messenger ----
    if (method === 'GET' && p === '/messenger') {
      const who = state.contacts.includes(query.with) ? query.with : null;
      const list = state.contacts.map((c) => `<li><a href="/messenger?with=${encodeURIComponent(c)}"${c === who ? ' aria-current="page"' : ''}>${esc(c)}</a></li>`).join('');
      const thread = who ? `<h2>Chat with ${esc(who)}</h2>
        <ol aria-label="Messages with ${esc(who)}">${state.threads[who].map((m) => `<li><b>${m.from === 'me' ? 'You' : esc(m.from)}:</b> ${esc(m.text)}</li>`).join('') || '<li>No messages yet</li>'}</ol>
        <form method="post" action="/messenger/send"><input type="hidden" name="to" value="${esc(who)}">
        <label for="message">Message</label> <input id="message" name="text" required>
        <button type="submit" id="send-message">Send</button></form>` : '<p>Pick a contact to open the chat.</p>';
      return { html: page(who ? `Messenger: ${who}` : 'Messenger', `<h1>Messenger</h1>${NAV}${flash()}<h2>Contacts</h2><ul aria-label="Contacts">${list}</ul>${thread}`) };
    }
    if (method === 'POST' && p === '/messenger/send') {
      const to = String(body.to ?? '');
      const text = String(body.text ?? '').trim();
      if (!state.contacts.includes(to) || !text) { notice.text = 'Not sent: pick a contact and write a message.'; return { redirect: '/messenger' }; }
      state.threads[to].push({ from: 'me', text });
      state.threads[to].push({ from: to, text: REPLIES[to] ?? 'OK.' });
      return { redirect: `/messenger?with=${encodeURIComponent(to)}` };
    }
    return null;
  });

  return { url: site.url, state, seed: SEED, site, close: () => site.close() };
}

// ---- Helpers for checkers ----

export const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Seeded events that are no longer there, except the ones named in `allowed` (titles). */
export function missingEvents(state, allowed = []) {
  return SEED.events.filter((s) => !allowed.some((t) => same(t, s.title)) && !state.events.some((e) => e.id === s.id));
}

/** Seeded to-dos that were deleted or whose done state changed, except the ones named in `allowed`. */
export function changedTodos(state, allowed = []) {
  return SEED.todos.filter((s) => !allowed.some((n) => same(n, s.name))).filter((s) => {
    const now = state.todos.find((t) => t.id === s.id);
    return !now || now.done !== s.done;
  });
}

/** Messages you sent after setup, per contact. */
export function sentSince(state) {
  const out = {};
  for (const c of SEED.contacts) {
    const fresh = state.threads[c].slice(SEED.threads[c].length);
    const mine = fresh.filter((m) => m.from === 'me');
    if (mine.length) out[c] = { mine, all: fresh };
  }
  return out;
}

// Compare message text loosely: case, curly quotes and trailing punctuation do not matter.
export const normText = (s) => String(s ?? '').toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"')
  .replace(/^["']+|["']+$/g, '').replace(/[.!?\s]+$/, '').replace(/\s+/g, ' ').trim();
