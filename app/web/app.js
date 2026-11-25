// Senju's web page: the team's control page. Sign in, manage the team, read sessions, and edit
// skills and memory. Sessions are started, continued and steered only from the desktop app;
// here they can be watched, never driven. Plans and payments live here too.
import { h, sticker, scribbleArrow } from './shared/brand.js';
import { createTraceView } from './shared/trace-view.js';
import { renderLibrary } from './shared/library-view.js';
import { checkSettings } from './shared/model-settings.js';

const app = document.getElementById('app');
const state = {
  sb: null, user: null, token: null, name: '',
  team: null,            // from /api/team
  model: null, billing: null,   // model: your own saved settings { saved, baseUrl, model, hasKey }, never the key
  ws: null, people: [], liveSession: null,   // presence from the hub
  page: 'sessions', sessions: [], selected: null, detail: null, tv: null, watching: false,
};

function toast(message) {
  const t = h('div', { class: 'toast' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 6000);
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { authorization: `Bearer ${state.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `The server answered ${res.status}.`);
  return out;
}

// ---- Start-up and sign-in -----------------------------------------------------------------

async function boot() {
  const cfg = await (await fetch('/api/config')).json();
  state.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  state.sb.auth.onAuthStateChange((_event, session) => onSession(session));
  onSession((await state.sb.auth.getSession()).data.session);
}

let lastUser = null;
async function onSession(session) {
  state.token = session?.access_token ?? null;
  state.user = session?.user ?? null;
  if ((state.user?.id ?? null) === lastUser && state.user) return;   // token refresh, same person
  lastUser = state.user?.id ?? null;
  state.ws?.close();
  if (!state.user) return viewAuth();
  await loadAccount();
}

async function loadAccount() {
  const { data: profile } = await state.sb.from('profiles').select('name').eq('id', state.user.id).maybeSingle();
  state.name = profile?.name ?? state.user.email;
  try { state.team = (await api('GET', '/api/team')).team; } catch { state.team = null; }
  if (!state.team) return viewOnboarding();
  await Promise.all([loadModel(), loadBilling()]);
  connect();
  const back = new URLSearchParams(location.search).get('billing');
  if (back) {
    history.replaceState(null, '', location.pathname);
    state.page = 'billing';
    toast(back === 'done' ? 'Payment received. Your balance updates in a few seconds.' : 'Nothing was charged.');
    if (back === 'done') for (const wait of [1500, 4000, 9000]) setTimeout(async () => { await loadBilling(); if (state.page === 'billing') render(); }, wait);
  }
  render();
}

async function loadModel() {
  try { state.model = await api('GET', '/api/model'); } catch { state.model = null; }
}

async function loadBilling() {
  try {
    const res = await fetch('/api/billing', { headers: { authorization: `Bearer ${state.token}` } });
    state.billing = res.ok ? await res.json() : null;
  } catch { state.billing = null; }
}

function stageTop(extra) {
  return h('header', { class: 'stage-top' }, h('span', { class: 'logo display' }, 'Senju'), extra);
}

function viewAuth(mode = 'in') {
  const err = h('p', { class: 'error-text' });
  const submit = async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const f = new FormData(ev.target);
    const creds = { email: f.get('email'), password: f.get('password') };
    const res = mode === 'up'
      ? await state.sb.auth.signUp({ ...creds, options: { data: { name: f.get('name') } } })
      : await state.sb.auth.signInWithPassword(creds);
    if (res.error) err.textContent = res.error.message;
    else if (mode === 'up' && !res.data.session) err.textContent = 'Check your email to confirm your account, then sign in.';
  };
  app.replaceChildren(h('main', { class: 'stage auth' },
    stageTop(),
    h('div', { class: 'auth-grid' },
      h('section', { class: 'hero' },
        h('h1', { class: 'display hero-title' }, h('span', { class: 'hash' }, '#'), 'Swarm', h('br'), 'your', h('br'), 'screen'),
        h('p', { class: 'hero-sub' }, 'Your team’s control room: who is in, what the agents did, and what they have learned.'),
        sticker(), scribbleArrow()),
      h('form', { class: 'panel-card', onsubmit: submit },
        h('div', { class: 'kicker' }, mode === 'up' ? 'New here' : 'Welcome back'),
        h('h2', { class: 'display card-title' }, mode === 'up' ? 'Create account' : 'Sign in'),
        mode === 'up' && h('input', { class: 'field', name: 'name', placeholder: 'Your name', required: true }),
        h('input', { class: 'field', name: 'email', type: 'email', placeholder: 'Email', required: true, autocomplete: 'username' }),
        h('input', { class: 'field', name: 'password', type: 'password', placeholder: 'Password', required: true, minlength: 8, autocomplete: mode === 'up' ? 'new-password' : 'current-password' }),
        err,
        h('button', { class: 'btn btn-punk', type: 'submit' }, mode === 'up' ? 'Create account →' : 'Sign in →'),
        h('p', { class: 'small dim' }, mode === 'up' ? 'Already have an account? ' : 'New here? ',
          h('button', { class: 'link', type: 'button', onclick: () => viewAuth(mode === 'up' ? 'in' : 'up') }, mode === 'up' ? 'Sign in' : 'Create an account'))))));
}

function viewOnboarding() {
  const err = h('p', { class: 'error-text' });
  const run = (fn, arg) => async (ev) => {
    ev.preventDefault();
    const { error } = await state.sb.rpc(fn, { [arg]: new FormData(ev.target).get('v') });
    if (error) err.textContent = error.message; else loadAccount();
  };
  app.replaceChildren(h('main', { class: 'stage auth' },
    stageTop(h('button', { class: 'btn btn-outline-white btn-sm', onclick: () => state.sb.auth.signOut() }, 'Sign out')),
    h('div', { class: 'panel-card wide' },
      h('div', { class: 'kicker' }, `Welcome, ${state.name}`),
      h('h2', { class: 'display card-title' }, 'Join a team'),
      h('p', { class: 'dim' }, 'A team shares sessions, skills and team memory, and its members can lend each other their computers. Create one, or join with an invite code.'),
      h('form', { class: 'inline', onsubmit: run('create_team', 'team_name') }, h('input', { class: 'field', name: 'v', placeholder: 'New team name', required: true }), h('button', { class: 'btn btn-punk' }, 'Create')),
      h('form', { class: 'inline', onsubmit: run('join_team', 'code') }, h('input', { class: 'field', name: 'v', placeholder: 'Invite code', required: true }), h('button', { class: 'btn btn-ink' }, 'Join')),
      err)));
}

// ---- Live connection to the hub: presence, and watching a running session -------------------------

function connect() {
  const ws = new WebSocket(location.origin.replace(/^http/, 'ws'));
  state.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: state.token, role: 'web' }));
  ws.onmessage = (m) => onHub(JSON.parse(m.data));
  ws.onclose = () => { if (state.ws === ws && state.user) setTimeout(async () => { state.token = (await state.sb.auth.getSession()).data.session?.access_token ?? state.token; if (state.user) connect(); }, 2500); };
}
const say = (msg) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(msg));

function onHub(msg) {
  if (msg.t === 'presence') {
    const was = state.liveSession?.id ?? null;
    state.people = msg.people;
    state.liveSession = msg.session;
    if (was !== (msg.session?.id ?? null)) { loadSessions(); if (!msg.session) state.watching = false; }
    if (state.page === 'team') render();
  } else if (msg.t === 'welcome') {
    state.liveSession = msg.session ? { id: msg.session.id, goal: msg.session.goal, owner: msg.session.owner } : null;
    state.watching = Boolean(msg.session?.joined);
  } else if (msg.t === 'joined') {
    state.watching = true;
    if (state.selected === msg.session.id) openSession(msg.session.id);   // reload with the full picture
  } else if (msg.t === 'event' && state.tv && msg.sessionId === state.selected) {
    if (msg.event.type === 'session' && (msg.event.turn ?? 0) >= state.tv.turnCount) state.tv.startTurn(msg.event.goal, msg.event.owner?.name ?? null);
    state.tv.push({ turn: msg.event.turn ?? Math.max(0, state.tv.turnCount - 1), at: new Date().toISOString(), event: msg.event });
  } else if (msg.t === 'error' && msg.code !== 'view_only') toast(msg.message);
}

// ---- The shell ----------------------------------------------------------------------------

const PAGES = [['sessions', 'Sessions'], ['team', 'Team'], ['library', 'Skills & memory'], ['billing', 'Model & billing']];

function render() {
  const nav = h('nav', { class: 'nav' }, PAGES.map(([id, label]) => h('button', { class: `nav-pill${state.page === id ? ' on' : ''}`, onclick: () => { state.page = id; render(); } }, label)));
  const top = h('header', { class: 'stage bar' },
    h('div', { class: 'bar-left' }, h('span', { class: 'logo display' }, 'Senju'), h('span', { class: 'team-tag' }, state.team.name)),
    nav,
    h('div', { class: 'bar-right' }, h('span', { class: 'me' }, state.name), h('button', { class: 'btn btn-outline-white btn-sm', onclick: () => state.sb.auth.signOut() }, 'Sign out')));
  const page = state.page === 'team' ? teamPage() : state.page === 'library' ? libraryPage() : state.page === 'billing' ? billingPage() : sessionsPage();
  app.replaceChildren(h('div', { class: 'shell' }, top, h('main', { class: 'content' }, page)));
}

// ---- Sessions -------------------------------------------------------------------------------

async function loadSessions() {
  try { state.sessions = (await api('GET', '/api/sessions')).sessions; } catch (err) { toast(err.message); state.sessions = []; }
  const list = document.querySelector('.session-list');
  if (list) list.replaceWith(sessionList());
}

function sessionList() {
  const box = h('div', { class: 'session-list' });
  if (!state.sessions.length) box.append(h('p', { class: 'dim pad' }, 'No sessions yet. Start one from the Senju desktop app.'));
  for (const s of state.sessions) {
    box.append(h('button', { class: `session-row${state.selected === s.id ? ' on' : ''}`, onclick: () => openSession(s.id) },
      h('span', { class: 'session-row-title' }, s.title || s.goal),
      h('span', { class: 'session-row-meta' },
        s.live ? h('span', { class: 'pill live' }, 'live') : h('span', { class: `pill ${s.status === 'done' ? 'done' : s.status === 'stopped' ? 'stopped' : ''}` }, s.status),
        ` ${s.ownerName} · ${new Date(s.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${s.turnCount} turn${s.turnCount === 1 ? '' : 's'}`)));
  }
  return box;
}

function sessionsPage() {
  if (!state.sessions.length) loadSessions();
  const viewer = h('section', { class: 'card viewer' });
  const page = h('div', { class: 'sessions' },
    h('aside', { class: 'card list-card' }, h('div', { class: 'card-head' }, h('h2', { class: 'display' }, 'Sessions'), h('span', { class: 'dim small' }, 'read-only')), sessionList()),
    viewer);
  if (state.selected) queueMicrotask(() => openSession(state.selected));
  else viewer.append(h('div', { class: 'viewer-empty' },
    h('h3', { class: 'display' }, 'Pick a session'),
    h('p', { class: 'dim' }, 'Every step the agents took, who asked what, and what came of it. To start or continue a session, use the Senju desktop app.')));
  return page;
}

async function openSession(id) {
  state.selected = id;
  document.querySelectorAll('.session-row').forEach((r, i) => r.classList.toggle('on', state.sessions[i]?.id === id));
  const viewer = document.querySelector('.viewer');
  if (!viewer) return;
  viewer.replaceChildren(h('p', { class: 'dim pad' }, 'Loading…'));
  let data;
  try { data = await api('GET', `/api/sessions/${encodeURIComponent(id)}`); } catch (err) { return viewer.replaceChildren(h('p', { class: 'error-text pad' }, err.message)); }
  if (state.selected !== id) return;
  state.detail = data.session;
  const d = data.session;
  const title = h('h2', { class: 'viewer-title display' }, d.title || d.goal);
  const actions = h('div', { class: 'viewer-actions' });
  if (d.live && !state.watching) actions.append(h('button', { class: 'btn btn-punk btn-sm', onclick: () => say({ t: 'join' }) }, 'Watch live'));
  if (d.canManage) {
    actions.append(h('button', { class: 'btn btn-ghost btn-sm', onclick: async () => {
      const name = prompt('Rename this session', d.title);
      if (!name) return;
      try { await api('PATCH', `/api/sessions/${encodeURIComponent(id)}`, { title: name }); await loadSessions(); openSession(id); } catch (err) { toast(err.message); }
    } }, 'Rename'));
    if (!d.live) actions.append(h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
      if (!confirm('Delete this session and its history for the whole team?')) return;
      try { await api('DELETE', `/api/sessions/${encodeURIComponent(id)}`); state.selected = null; await loadSessions(); render(); } catch (err) { toast(err.message); }
    } }, 'Delete'));
  }
  const host = h('div', { class: 'tv-host' });
  viewer.replaceChildren(
    h('header', { class: 'viewer-head' },
      h('div', {}, title, h('div', { class: 'viewer-sub dim' }, d.live ? h('span', { class: 'pill live' }, 'live') : null, ` Started by ${d.ownerName} · ${d.turns.length} turn${d.turns.length === 1 ? '' : 's'}${d.participant ? '' : ' · you were not in it, so you see the outline only'}`)),
      actions),
    h('div', { class: 'tv-scroll' }, host),
    h('footer', { class: 'viewer-foot dim' }, 'Continue this session from the Senju desktop app: the lead remembers everything so far.'));
  state.tv = createTraceView(host);
  state.tv.load(d, data.events, { canShowResults: false });
}

// ---- Team -----------------------------------------------------------------------------------

function teamPage() {
  const t = state.team;
  const online = new Map(state.people.map((p) => [p.id, p]));
  const err = h('p', { class: 'error-text' });
  const act = (fn) => async () => { err.textContent = ''; try { await fn(); state.team = (await api('GET', '/api/team')).team; render(); } catch (x) { err.textContent = x.message; } };
  return h('div', { class: 'team' },
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'display' }, t.name), t.isOwner ? h('button', { class: 'btn btn-ghost btn-sm', onclick: act(async () => { const name = prompt('Team name', t.name); if (name) await api('PATCH', '/api/team', { name }); }) }, 'Rename') : null),
      h('div', { class: 'invite' },
        h('div', {}, h('div', { class: 'kicker' }, 'Invite code'), h('code', { class: 'code' }, t.inviteCode)),
        h('button', { class: 'btn btn-punk btn-sm', onclick: () => { navigator.clipboard.writeText(t.inviteCode); toast('Invite code copied.'); } }, 'Copy'),
        t.isOwner ? h('button', { class: 'btn btn-ghost btn-sm', onclick: act(async () => { if (confirm('Make a new code? The old one stops working.')) await api('POST', '/api/team/invite'); }) }, 'New code') : null),
      h('p', { class: 'dim small' }, 'Teammates join from this page with the code, then sign in to the desktop app with the same account.')),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'display' }, 'People'), state.liveSession ? h('span', { class: 'pill live' }, `${state.liveSession.owner?.name ?? 'Someone'}’s session is running`) : null),
      h('div', { class: 'members' }, t.members.map((m) => {
        const p = online.get(m.id);
        return h('div', { class: 'member' },
          h('span', { class: `presence ${p ? 'on' : ''}` }),
          h('div', { class: 'member-name' }, h('b', {}, m.name, m.id === t.me ? ' (you)' : ''), h('span', { class: 'dim small' }, p ? [p.devices.map((d) => `${d.name}${d.inSession ? ' · in the session' : ''}`).join(', '), p.web ? (p.devices.length ? ' · web' : 'on the web') : ''].join('') || 'online' : 'offline')),
          h('span', { class: 'pill' }, m.role),
          t.isOwner && m.id !== t.me ? h('button', { class: 'link', onclick: act(async () => { if (confirm(`Remove ${m.name} from the team?`)) await api('DELETE', `/api/team/members/${encodeURIComponent(m.id)}`); }) }, 'Remove') : null);
      })),
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
        if (!confirm(`Leave ${t.name}?`)) return;
        try { await api('POST', '/api/team/leave'); loadAccount(); } catch (x) { err.textContent = x.message; }
      } }, 'Leave team'))));
}

// ---- Skills & memory --------------------------------------------------------------------------

function libraryPage() {
  const box = h('section', { class: 'card library' });
  renderLibrary(box, {
    skills: async () => (await api('GET', '/api/skills')).skills,
    saveSkill: ({ name, description, body }) => api('PUT', `/api/skills/${encodeURIComponent(name)}`, { description, body }),
    deleteSkill: (name) => api('DELETE', `/api/skills/${encodeURIComponent(name)}`),
    notes: async () => (await api('GET', '/api/memory')).notes,
    addNote: (note, scope) => api('POST', '/api/memory', { note, scope }),
    deleteNote: (id) => api('DELETE', `/api/memory/${encodeURIComponent(id)}`),
  }, { team: true });
  return box;
}

// ---- Model & billing: your own model settings, plan and credits ---------------------------------

// Your own model: any OpenAI-compatible endpoint. The server keeps the key encrypted and never sends it back.
function modelCard(hosted) {
  const m = state.model ?? { saved: false, baseUrl: '', model: '', hasKey: false };
  const err = h('p', { class: 'error-text' });
  const baseUrl = h('input', { class: 'field', name: 'baseUrl', placeholder: 'Base URL of an OpenAI-compatible endpoint', autocomplete: 'off', spellcheck: 'false' });
  const model = h('input', { class: 'field', name: 'model', placeholder: 'Model name', autocomplete: 'off', spellcheck: 'false' });
  const apiKey = h('input', { class: 'field', name: 'apiKey', type: 'password', autocomplete: 'off' });
  const keepsKey = () => m.hasKey && baseUrl.value.trim().replace(/\/+$/, '') === m.baseUrl;
  const keyHint = () => {
    apiKey.placeholder = keepsKey() ? 'API key (leave blank to keep the saved one)' : 'API key (if the endpoint needs one)';
  };
  baseUrl.value = m.saved ? m.baseUrl : '';
  model.value = m.saved ? m.model : '';
  baseUrl.oninput = keyHint;
  keyHint();
  const save = async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    const body = { baseUrl: baseUrl.value.trim(), model: model.value.trim(), apiKey: apiKey.value.trim() };
    // The same check the server makes, so mistakes show at once. A blank key keeps the saved one (same base URL only).
    const problem = checkSettings({ ...body, apiKey: body.apiKey || (keepsKey() ? 'saved' : '') });
    if (problem) { err.textContent = problem; return; }
    try { await api('POST', '/api/model', body); } catch (x) { err.textContent = x.message; return; }
    await Promise.all([loadModel(), loadBilling()]);
    toast('Model settings saved.');
    render();
  };
  const remove = async () => {
    if (!confirm('Remove your model settings and saved key?')) return;
    try { await api('DELETE', '/api/model'); } catch (x) { err.textContent = x.message; return; }
    await Promise.all([loadModel(), loadBilling()]);
    render();
  };
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { class: 'display' }, hosted ? 'Or use your own model' : 'Your model'), m.saved ? h('span', { class: 'pill done' }, 'saved') : null),
    h('p', { class: 'dim' }, 'Sessions you start run on this model, free of credits. Any OpenAI-compatible chat completions endpoint works: a hosted API, or a server you run. The key is encrypted on the server and never shown again, and teammates cannot use it for their own sessions.'),
    m.saved ? h('p', { class: 'small' }, `Saved: ${m.model || 'the server’s model'} at ${m.baseUrl || 'the server’s endpoint'}, ${m.hasKey ? 'with a key' : 'no key'}. `, h('button', { class: 'link', type: 'button', onclick: remove }, 'Remove')) : null,
    h('form', { class: 'model-form', onsubmit: save },
      h('label', { class: 'small dim' }, 'Base URL', baseUrl),
      h('label', { class: 'small dim' }, 'Model', model),
      h('label', { class: 'small dim' }, 'API key', apiKey),
      err,
      h('div', { class: 'row left' }, h('button', { class: 'btn btn-punk', type: 'submit' }, m.saved ? 'Save changes' : 'Save'))));
}

function billingPage() {
  const err = h('p', { class: 'error-text' });
  const b = state.billing;
  const pay = async (path, body) => {
    try { location.href = (await api('POST', path, body ?? {})).url; } catch (x) { err.textContent = x.message; }   // Stripe's own page takes the card
  };
  const plan = b?.hosted ? h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { class: 'display' }, 'Plan & credits'), b.active ? h('span', { class: 'pill done' }, 'subscribed') : null),
    h('p', { class: 'dim small' }, 'Without your own model, sessions you start run on this server’s model and are paid for in credits.'),
    !b.payments
      ? h('p', { class: 'dim' }, 'Payments are not set up on this server yet.')
      : b.active
        ? h('div', {},
          h('div', { class: 'balance' }, h('span', { class: 'kicker' }, 'Balance'), h('span', { class: 'display big' }, b.creditsText)),
          b.periodEnd ? h('p', { class: 'dim small' }, `Next $${b.plan.creditsUsd} of credits on ${new Date(b.periodEnd).toLocaleDateString()}.`) : null,
          h('div', { class: 'row left' }, b.topups.map((usd) => h('button', { class: 'btn btn-punk btn-sm', onclick: () => pay('/api/billing/checkout', { kind: 'topup', amount: usd }) }, `Add $${usd}`)),
            h('button', { class: 'link', onclick: () => pay('/api/billing/portal') }, 'Change card or cancel')))
        : h('div', {},
          h('p', {}, `$${b.plan.usd} a month. Each month adds $${b.plan.creditsUsd} of credits, and unused credits carry over. Sessions you start are charged for the tokens they use.`),
          b.credits > 0 ? h('p', { class: 'dim small' }, `You still have ${b.creditsText} of credits from before. They are usable again once you subscribe.`) : null,
          h('button', { class: 'btn btn-punk', onclick: () => pay('/api/billing/checkout', { kind: 'subscribe' }) }, 'Subscribe →')),
    b.hasOwnModel ? h('p', { class: 'dim small' }, 'You have your own model saved, so your sessions run on it and cost no credits.') : null,
    err) : null;
  return h('div', { class: 'billing' }, modelCard(Boolean(b?.hosted ?? state.model?.hosted)), plan);
}

boot().catch((err) => { app.replaceChildren(h('p', { class: 'error-text pad' }, `Could not start: ${err.message}`)); });
