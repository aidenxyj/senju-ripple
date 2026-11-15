// The launcher window: choose how to work, then a chat-like home of sessions, plus skills and memory.
// Talks to the main process through window.senju (src/launcher-preload.cjs).
import { createTraceView } from '../web/shared/trace-view.js';
import { h, sticker, scribbleArrow } from '../web/shared/brand.js';
import { renderLibrary } from '../web/shared/library-view.js';

const $app = document.getElementById('app');
const senju = window.senju;

async function call(name, ...args) {
  const res = await senju[name](...args);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

// ---- State ----
const app = {
  s: null,                 // the main process's state (mode, account, running…)
  view: 'loading',         // choose | key | signin | home
  panel: 'new',            // new | session | library
  selected: null,          // session id
  sessions: [],
  detail: null,            // the selected session's meta
  tv: null,                // the trace view on screen
  libTab: 'skills',
  error: '',
};

async function refreshState() { app.s = await call('state'); return app.s; }

async function boot() {
  await refreshState();
  if (!app.s.mode && app.s.fixedMode) await call('chooseMode', app.s.fixedMode).then((s) => { app.s = s; });
  route();
}

// Where to go from the current state.
function route() {
  const s = app.s;
  if (!s.mode) app.view = 'choose';
  else if (!s.team && !s.hasKey) app.view = 'key';
  else if (s.team && s.account?.state !== 'signed_in') app.view = 'signin';
  else app.view = 'home';
  render();
  if (app.view === 'home') loadSessions();
}

function render() {
  document.body.dataset.view = app.view;
  if (app.view === 'loading') return $app.replaceChildren();
  if (app.view === 'choose') return $app.replaceChildren(chooseScreen());
  if (app.view === 'key') return $app.replaceChildren(keyScreen());
  if (app.view === 'signin') return $app.replaceChildren(signinScreen());
  return $app.replaceChildren(homeScreen());
}

// ---- The first screen: personal or team ----
function chooseScreen() {
  const pick = async (mode) => {
    try { app.s = await call('chooseMode', mode); route(); } catch (err) { app.error = err.message; render(); }
  };
  const card = (mode, kicker, title, lines, cta) => h('button', { class: `choice${app.s.lastMode === mode ? ' last' : ''}`, onclick: () => pick(mode) },
    h('span', { class: 'choice-kicker' }, kicker),
    h('span', { class: 'choice-title' }, title),
    h('ul', {}, lines.map((l) => h('li', {}, l))),
    h('span', { class: 'btn btn-punk' }, cta, ' →'));
  return h('main', { class: 'stage choose' },
    h('header', { class: 'top drag' }, h('span', { class: 'logo display' }, 'Senju'), h('span', { class: 'top-pills' }, h('button', { class: 'btn btn-outline-white btn-sm nodrag', onclick: () => call('openWeb') }, 'Team web page ↗'))),
    h('section', { class: 'hero' },
      h('h1', { class: 'display hero-title' }, h('span', { class: 'hash' }, '#'), 'Swarm', h('br'), 'your', h('br'), 'screen'),
      sticker(), scribbleArrow()),
    h('section', { class: 'choices' },
      card('local', 'Personal', 'On this Mac', ['Your own API key', 'Your sessions stay on this Mac', 'Agents use your apps and browser'], 'Start personal'),
      card('team', 'Team', 'With your team', ['Sign in to your team', 'Share sessions, skills and memory', 'Agents can work across teammates’ Macs'], app.s.demo ? 'Not in demo' : 'Sign in to team')),
    app.error ? h('p', { class: 'stage-error' }, app.error) : null,
    h('p', { class: 'stage-foot' }, 'You can switch any time from the ◎ menu bar icon.'));
}

function keyScreen() {
  const input = h('input', { class: 'field', type: 'password', placeholder: 'B200 server key', autofocus: true });
  const err = h('p', { class: 'error-text' });
  const save = async () => {
    try { app.s = await call('saveKey', input.value); route(); } catch (e) { err.textContent = e.message; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  return h('main', { class: 'stage centered' },
    h('header', { class: 'top drag' }, h('span', { class: 'logo display' }, 'Senju')),
    h('div', { class: 'panel-card' },
      h('div', { class: 'choice-kicker' }, 'Personal'),
      h('h2', { class: 'display card-title' }, 'Your Ripple API key'),
      h('p', { class: 'dim' }, 'Personal sessions run on your own Ripple B200 (Vast.ai); paste the key its vLLM server was started with. It is stored encrypted in this Mac’s keychain and never leaves it.'),
      input, err,
      h('div', { class: 'row' }, h('button', { class: 'btn btn-ghost', onclick: () => back() }, '← Back'), h('button', { class: 'btn btn-punk', onclick: save }, 'Save key'))));
}

function signinScreen() {
  const acct = app.s.account;
  const email = h('input', { class: 'field', type: 'email', placeholder: 'you@example.com', autocomplete: 'username' });
  const pass = h('input', { class: 'field', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const err = h('p', { class: 'error-text' }, acct?.error ?? '');
  const go = async () => {
    err.textContent = '';
    try { await call('signIn', email.value, pass.value); } catch (e) { err.textContent = e.message; }
  };
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  let body;
  if (acct?.state === 'no_team') {
    body = [h('h2', { class: 'display card-title' }, 'No team yet'), h('p', { class: 'dim' }, 'You are signed in but not in a team. Create one or join with an invite code on the team web page, then come back.'),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-ghost', onclick: () => call('signOut') }, 'Sign out'), h('button', { class: 'btn btn-punk', onclick: () => call('openWeb') }, 'Open the web page ↗'))];
  } else if (!acct || acct.state === 'offline') {
    body = [h('h2', { class: 'display card-title' }, 'Connecting'), h('p', { class: 'dim' }, acct?.error ?? 'Reaching your team server…')];
  } else {
    body = [h('h2', { class: 'display card-title' }, 'Sign in'), h('p', { class: 'dim' }, 'Use the account you made on the team web page.'), email, pass, err,
      h('div', { class: 'row' }, h('button', { class: 'btn btn-ghost', onclick: () => call('openWeb') }, 'Create an account ↗'), h('button', { class: 'btn btn-punk', onclick: go }, 'Sign in'))];
  }
  return h('main', { class: 'stage centered' },
    h('header', { class: 'top drag' }, h('span', { class: 'logo display' }, 'Senju')),
    h('div', { class: 'panel-card' }, h('div', { class: 'choice-kicker' }, 'Team'), ...body, h('button', { class: 'link', onclick: back }, '← Work on this Mac instead')));
}

// Back to the first screen. Nothing changes until another way of working is picked there.
function back() {
  app.view = 'choose';
  render();
}

// ---- Home: sessions on the left, the chosen one (or a new one, or the library) on the right ----
async function loadSessions() {
  try { app.sessions = await call('sessions'); } catch (err) { app.sessions = []; app.error = err.message; }
  const side = document.querySelector('.side-list');
  if (side) side.replaceWith(sessionList());
}

function groupOf(iso) {
  const d = new Date(iso), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'This week' : 'Earlier';
}

function sessionList() {
  const groups = new Map();
  for (const s of app.sessions) {
    const g = groupOf(s.updatedAt ?? s.startedAt);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const list = h('nav', { class: 'side-list' });
  if (!app.sessions.length) list.append(h('p', { class: 'side-empty' }, 'Your sessions will show up here.'));
  for (const [g, rows] of groups) {
    list.append(h('div', { class: 'side-group' }, g));
    for (const s of rows) {
      list.append(h('button', { class: `side-item${app.selected === s.id && app.panel === 'session' ? ' on' : ''}`, onclick: () => openSession(s.id) },
        h('span', { class: 'side-title' }, s.title || 'Untitled'),
        h('span', { class: 'side-meta' }, s.live ? h('span', { class: 'pill live' }, 'live') : `${s.turnCount} turn${s.turnCount === 1 ? '' : 's'}`)));
    }
  }
  return list;
}

function homeScreen() {
  const s = app.s;
  const who = s.team ? (s.account?.team?.name ?? 'Team') : 'Personal';
  const side = h('aside', { class: 'side stage' },
    h('div', { class: 'side-top drag' }),
    h('div', { class: 'side-brand' }, h('span', { class: 'logo display' }, 'Senju'), h('span', { class: 'side-mode' }, who)),
    h('button', { class: 'btn btn-punk side-new', onclick: () => { app.panel = 'new'; app.selected = null; render(); } }, '+ New session'),
    sessionList(),
    h('div', { class: 'side-bottom' },
      h('button', { class: `side-link${app.panel === 'library' ? ' on' : ''}`, onclick: () => { app.panel = 'library'; render(); } }, 'Skills & memory'),
      s.team ? h('button', { class: 'side-link', onclick: () => call('openWeb') }, 'Team web page ↗') : null,
      h('div', { class: 'side-account' },
        h('span', {}, s.team ? (s.account?.user?.name ?? '') : 'On this Mac'),
        h('button', { class: 'link light', onclick: () => switchMode() }, s.team ? 'Switch to personal' : 'Switch to team'),
        s.team ? h('button', { class: 'link light', onclick: async () => { await call('signOut'); } }, 'Sign out') : null)));
  let main;
  if (app.panel === 'library') main = libraryPanel();
  else if (app.panel === 'session' && app.selected) main = sessionPanel();
  else main = newPanel();
  return h('div', { class: 'home' }, side, main);
}

async function switchMode() {
  try { app.s = await call('chooseMode', app.s.team ? 'local' : 'team'); app.panel = 'new'; app.selected = null; route(); } catch (err) { alert(err.message); }
}

function composer({ sessionId = null, placeholder }) {
  const running = app.s.running;
  const box = h('textarea', { class: 'composer-input', rows: 1, placeholder: running ? 'A job is running. Use the bar at the top of your screen to talk to it.' : placeholder, disabled: running });
  const err = h('div', { class: 'composer-error' });
  const sendIt = async () => {
    const goal = box.value.trim();
    if (!goal) return;
    err.textContent = '';
    try {
      const out = await call('send', goal, sessionId);
      box.value = '';
      if (out?.sessionId) { app.selected = out.sessionId; app.panel = 'session'; }
    } catch (e) { err.textContent = e.message; }
  };
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); } });
  box.addEventListener('input', () => { box.style.height = 'auto'; box.style.height = `${Math.min(220, box.scrollHeight)}px`; });
  return h('div', { class: 'composer' },
    h('div', { class: 'composer-box' }, box,
      running ? h('button', { class: 'btn btn-ink btn-sm', onclick: () => call('showOverlay') }, 'Show the bar')
        : h('button', { class: 'btn btn-punk btn-sm', onclick: sendIt }, sessionId ? 'Continue' : 'Start', h('span', { class: 'kbd on-punk' }, '↩'))),
    err,
    h('div', { class: 'composer-hint' }, `Agents take over the screen while they work. ${app.s.hotkey ? `${app.s.hotkey} brings Senju back.` : ''}`));
}

function newPanel() {
  return h('section', { class: 'main new' },
    h('div', { class: 'main-top drag' }),
    h('div', { class: 'new-center' },
      h('h1', { class: 'display new-title' }, 'What should', h('br'), 'the swarm do?'),
      composer({ placeholder: 'e.g. Compare AirPods Pro prices at three stores' }),
      h('div', { class: 'new-ideas' }, ['Play today’s Wordle and a game of Minesweeper', 'Summarise my unread email into a Notes page', 'Research three standing desks and compare them'].map((idea) =>
        h('button', { class: 'idea', onclick: (e) => { const t = e.currentTarget.closest('.new-center').querySelector('textarea'); t.value = idea; t.focus(); } }, idea)))));
}

async function openSession(id) {
  app.selected = id;
  app.panel = 'session';
  app.detail = null;
  render();
  try {
    const { session, events } = await call('session', id);
    if (app.selected !== id) return;
    app.detail = session;
    const head = document.querySelector('.session-head');
    if (head) head.replaceWith(sessionHead());
    app.tv.load(session, events, { canShowResults: Boolean(session.results) });
    const scroller = document.querySelector('.tv-scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  } catch (err) {
    document.querySelector('.tv-host')?.replaceChildren(h('p', { class: 'error-text' }, err.message));
  }
}

function sessionHead() {
  const d = app.detail;
  const row = app.sessions.find((x) => x.id === app.selected);
  const title = d?.title ?? row?.title ?? '…';
  const live = row?.live || d?.status === 'running';
  const t = h('h2', { class: 'session-title', title: 'Double-click to rename' }, title);
  if (d?.canManage) {
    t.addEventListener('dblclick', () => {
      const input = h('input', { class: 'field rename', value: title });
      const done = async () => { const v = input.value.trim(); if (v && v !== title) { await call('rename', app.selected, v).catch(() => {}); await loadSessions(); app.detail = { ...app.detail, title: v }; } document.querySelector('.session-head')?.replaceWith(sessionHead()); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') document.querySelector('.session-head')?.replaceWith(sessionHead()); });
      input.addEventListener('blur', done);
      t.replaceWith(input);
      input.focus();
      input.select();
    });
  }
  return h('header', { class: 'session-head drag' },
    h('div', { class: 'session-head-text nodrag' }, t,
      h('div', { class: 'session-sub' }, live ? h('span', { class: 'pill live' }, 'live') : null, d ? `${d.turns?.length ?? 0} turn${d.turns?.length === 1 ? '' : 's'}` : '', d?.ownerName ? ` · started by ${d.ownerName}` : '')),
    d?.canManage ? h('div', { class: 'session-actions nodrag' }, h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
      if (!confirm('Delete this session and its history?')) return;
      try { await call('remove', app.selected); app.selected = null; app.panel = 'new'; await loadSessions(); render(); } catch (err) { alert(err.message); }
    } }, 'Delete')) : null);
}

function sessionPanel() {
  const host = h('div', { class: 'tv-host' });
  app.tv = createTraceView(host);
  const row = app.sessions.find((x) => x.id === app.selected);
  return h('section', { class: 'main session' },
    sessionHead(),
    h('div', { class: 'tv-scroll' }, h('div', { class: 'tv-wrap' }, host)),
    composer({ sessionId: app.selected, placeholder: row?.live ? '' : 'Continue this session: the lead remembers everything so far' }));
}

// ---- Skills & memory ----
function libraryPanel() {
  const panel = h('section', { class: 'main library' });
  renderLibrary(panel, {
    skills: () => call('skills'),
    saveSkill: (skill) => call('saveSkill', skill),
    deleteSkill: (name) => call('deleteSkill', name),
    notes: () => call('notes'),
    addNote: (note, scope) => call('addNote', note, scope),
    deleteNote: (id) => call('deleteNote', id),
  }, { team: app.s.team, tab: app.libTab });
  return panel;
}

// ---- Live updates from the main process ----
senju.onEvent(async (msg) => {
  if (msg.kind === 'account') {
    app.s = { ...app.s, account: msg.account };
    if (['signin', 'home'].includes(app.view)) route();
  } else if (msg.kind === 'mode') {
    app.s = msg.state;
    route();
  } else if (msg.kind === 'state') {
    app.s = { ...app.s, running: msg.running };
    if (app.view === 'home') {
      const box = document.querySelector('.composer');
      if (box && app.panel !== 'library') box.replaceWith(composer({ sessionId: app.panel === 'session' ? app.selected : null, placeholder: 'Continue this session: the lead remembers everything so far' }));
      loadSessions();
    }
  } else if (msg.kind === 'sessions') {
    await loadSessions();
    if (app.panel === 'session' && app.selected === msg.sessionId && !app.s.running) openSession(msg.sessionId);
  } else if (msg.kind === 'live') {
    // A new session started from the bar or elsewhere: follow it if nothing else is open.
    if (app.view === 'home' && app.panel === 'new' && msg.row.event.type === 'session') { await loadSessions(); app.selected = msg.sessionId; app.panel = 'session'; render(); return openSession(msg.sessionId); }
    if (app.panel === 'session' && app.selected === msg.sessionId && app.tv) {
      if (msg.row.event.type === 'session' && msg.row.turn >= app.tv.turnCount) app.tv.startTurn(msg.row.event.goal, msg.row.event.owner?.name ?? null);
      app.tv.push(msg.row);
    }
  }
});

boot().catch((err) => $app.replaceChildren(h('main', { class: 'stage centered' }, h('p', {}, err.message))));
