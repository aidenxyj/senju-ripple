// Overlay UI: prompt bar, agent chips (also the chat targets), chat thread,
// request cards over each agent's window, result card, and the ghost cursors.
const $ = (id) => document.getElementById(id);
const bar = $('bar'), prompt = $('prompt'), go = $('go'), stop = $('stop'), resetBtn = $('reset');
const chips = $('chips'), card = $('card'), toasts = $('toasts'), cursorsEl = $('cursors'), dot = $('state-dot');
const thread = $('thread');

const agents = new Map();   // id -> { name, color, status, label, el, chip, target }
const questions = [];       // pending ask_user / handoff requests
const logs = new Map();     // chat target id ('lead' or agent id) -> [{ me, name, text }]
const lead = { id: 'lead', name: 'Lead', color: '#f2f3f5', status: 'idle', label: '', chip: null };
let state = 'idle';
let demo = false;
let usageText = '';
let returnKey = '';
// Team mode: who and where we are, as the hub sees it.
const team = { on: false, account: 'solo', user: null, name: '', device: null, url: '', owner: null, people: [] };
let target = 'lead';        // who the prompt bar talks to while a job runs

// The window ignores the mouse except over elements marked .hit, so your
// clicks reach the apps underneath everywhere else.
let overHit = false;
let dragging = false;      // a card is being dragged, so keep the overlay interactive
function wireHit(el) {
  el.addEventListener('mouseenter', () => { overHit = true; window.swarm.setInteractive(true); });
  el.addEventListener('mouseleave', () => { if (dragging) return; overHit = false; window.swarm.setInteractive(false); });
}
function recheckHit() {
  // An element under the mouse was removed, so mouseleave never fired.
  overHit = Boolean(document.querySelector('.hit:hover'));
  window.swarm.setInteractive(overHit);
}
document.querySelectorAll('.hit').forEach(wireHit);

// enter/leave alone can leave the overlay stuck taking the mouse: a card that moves or disappears
// from under the pointer never fires mouseleave, and then your clicks stop reaching your apps.
// So also decide from what is actually under the pointer, on every (forwarded) mouse move and
// whenever the overlay's contents change.
let lastPointer = null;
function hitAt(x, y) { return Boolean(document.elementFromPoint(x, y)?.closest('.hit')); }
function syncHit() {
  if (dragging) return;
  const want = lastPointer ? hitAt(lastPointer.x, lastPointer.y) : false;
  if (want !== overHit) { overHit = want; window.swarm.setInteractive(want); }
}
document.addEventListener('mousemove', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; syncHit(); }, { passive: true });
document.addEventListener('mouseleave', () => { lastPointer = null; if (!dragging) { overHit = false; window.swarm.setInteractive(false); } });
window.addEventListener('blur', () => { if (!dragging && !document.querySelector('.hit:hover')) { overHit = false; window.swarm.setInteractive(false); } });
let syncQueued = false;
new MutationObserver(() => {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => { syncQueued = false; syncHit(); });
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });

const add = (parent, tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  parent.append(n);
  return n;
};

// ---- Cursors ------------------------------------------------------------------

function cursorSvg(color) {
  return `<svg class="arrow" viewBox="0 0 24 24"><path d="M4 2.5l15.5 8.2-6.6 1.9-2.6 6.6z" fill="${color}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>` +
    `<svg class="ibeam" viewBox="0 0 24 24"><path d="M8 3.5h8M12 3.5v17M8 20.5h8" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/>` +
    `<path d="M8 3.5h8M12 3.5v17M8 20.5h8" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/></svg>`;
}

// One continuous glide from wherever the cursor is now (CSS restarts a transition from the current spot, even
// mid-flight). Quick but easy to follow: 160 to 380 ms by distance. Returns the glide time.
function moveCursor(agent, spot, ms, easing = 'cubic-bezier(0.25, 0.8, 0.35, 1)') {
  const x = Math.round(spot.x), y = Math.round(spot.y);
  const p = agent.pos;
  if (p && Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1) return 0;
  const dur = ms ?? (p ? Math.round(Math.min(380, 160 + Math.hypot(x - p.x, y - p.y) * 0.22)) : 300);
  agent.el.style.transition = `transform ${dur}ms ${easing}, opacity 0.4s`;
  agent.el.style.transform = `translate(${x}px, ${y}px)`;
  agent.pos = { x, y };
  return dur;
}

// Plays one action from main ('cursor' event): glide there, then a tap for a click, or for typing an I-beam that
// runs along the field (or the address bar, with the url appearing in it) while the letters go in.
function playCursor(agent, e) {
  agent.target = { ...(agent.target ?? {}), x: e.x, y: e.y };
  agent.el.classList.add('pinned');
  clearTimeout(agent.playTimer);
  agent.el.classList.remove('typing', 'tapping');
  if (e.kind === 'type' && e.from) {
    const glide = moveCursor(agent, e.from);
    const ms = Math.max(80, e.ms || 0);
    agent.busyUntil = Date.now() + glide + ms + 60;
    agent.playTimer = setTimeout(() => {
      agent.el.classList.add('typing');
      if (e.text) typeBubble(e.from, e.text, ms);
      moveCursor(agent, e, ms, 'linear');
      agent.playTimer = setTimeout(() => { agent.el.classList.remove('typing'); agent.busyUntil = 0; }, ms + 60);
    }, glide);
    return;
  }
  const glide = moveCursor(agent, e);
  agent.busyUntil = Date.now() + glide;
  agent.playTimer = setTimeout(() => {
    agent.busyUntil = 0;
    agent.el.classList.add('tapping');
    agent.playTimer = setTimeout(() => agent.el.classList.remove('tapping'), 220);
  }, glide);
}

// The url being typed into the browser's address bar: a pill over it whose letters appear over `ms`.
function typeBubble(at, text, ms) {
  const pill = add(cursorsEl, 'div', 'type-bubble');
  pill.style.transform = `translate(${Math.round(at.x - 12)}px, ${Math.round(at.y - 13)}px)`;
  const started = performance.now();
  const step = () => {
    const n = Math.min(text.length, Math.ceil((text.length * (performance.now() - started)) / ms));
    pill.textContent = text.slice(0, n);
    if (n < text.length) requestAnimationFrame(step);
    else setTimeout(() => pill.remove(), 700);
  };
  requestAnimationFrame(step);
}

function restSpot(index, count) {
  // Parked in a row just under the prompt bar and its cards.
  const gap = 120, w = window.innerWidth;
  const below = $('dock').getBoundingClientRect().bottom + 12;
  return { x: w / 2 - ((count - 1) * gap) / 2 + index * gap - 30, y: below };
}

function laneSpot(index) {
  // Working, but the app has no window on screen: wait along the right edge.
  return { x: window.innerWidth - 300, y: 150 + index * 58 };
}

const ACTIVE = ['thinking', 'acting', 'starting', 'waiting', 'blocked', 'paused'];

function place(agent, index) {
  const resting = state !== 'running';
  const active = ACTIVE.includes(agent.status);
  // Team mode: an agent called to another computer shows its cursor there, not here.
  // Docked agents (resting, or not yet on any computer) show on every screen.
  const away = (team.on && !resting && active && agent.device && agent.device !== team.device)
    || (!resting && active && agent.target?.elsewhere);   // its window is on another desktop (Space) or minimized
  agent.el.classList.toggle('away', Boolean(away));
  if (away) return;
  let spot;
  if (resting || !active) spot = restSpot(index, agents.size);
  else if (agent.target && agent.target.x != null) spot = agent.target;
  else if (agent.target) spot = laneSpot(index);          // has an app but no visible window
  else spot = restSpot(index, agents.size);                // not using any app yet
  // Mid-action (gliding to an element, typing) the action owns the cursor; otherwise glide to the spot.
  if (!(agent.busyUntil > Date.now())) moveCursor(agent, spot);
  if (resting || !active) agent.el.classList.remove('pinned');
  agent.el.classList.toggle('resting', resting || !active);
  agent.el.dataset.status = resting ? 'rest' : agent.status;
  const where = active && agent.target?.app ? agent.target.app : '';
  let detail = '';
  if (!resting) {
    if (agent.status === 'acting' || agent.status === 'blocked' || agent.status === 'paused') detail = agent.label;
    else if (agent.status === 'waiting') detail = 'needs you';
    else if (agent.status === 'thinking') detail = where ? `thinking in ${where}` : 'thinking';
    else if (agent.status === 'cancelled') detail = 'stopped';
    else detail = agent.status;
  }
  const tag = agent.el.querySelector('.tag');
  tag.textContent = agent.name;
  if (detail) add(tag, 'small', '', detail);
}

function placeAll() { [...agents.values()].forEach((a, i) => place(a, i)); placeCards(); }

// ---- Chips and chat ---------------------------------------------------------------

function makeChip(who) {
  const chip = add(chips, 'div', 'chip hit');
  chip.style.setProperty('--agent', who.color);
  chip.title = who.id === 'lead' ? 'Lead agent: plans, supervises, replans. Click to chat.' : `${who.goal}\nClick to chat with this worker.`;
  add(chip, 'i').style.background = who.color;
  add(chip, 'b', '', who.name);
  add(chip, 'span', '', who.id === 'lead' ? '' : 'starting');
  chip.addEventListener('click', () => selectTarget(target === who.id && who.id !== 'lead' ? 'lead' : who.id));
  wireHit(chip);
  who.chip = chip;
  return chip;
}

function setChip(who, status, label) {
  if (!who.chip) return;
  who.chip.dataset.status = status;
  let text = label || (status === 'idle' ? '' : status);
  // Team mode: say whose computer an agent is on, and who it is waiting for.
  if (team.on && who.waitingFor && status === 'waiting') text = `waiting for ${who.waitingFor}`;
  else if (team.on && who.deviceName && who.device !== team.device && ACTIVE.includes(status)) text = `${text} · on ${who.deviceName}`;
  who.chip.querySelector('span').textContent = text;
}

function whoIs(id) { return id === 'lead' ? lead : agents.get(id); }

function selectTarget(id) {
  target = whoIs(id) ? id : 'lead';
  for (const w of [lead, ...agents.values()]) w.chip?.classList.toggle('selected', w.id === target);
  whoIs(target)?.chip?.classList.remove('unread');
  renderThread();
  refreshBar();
  if (state === 'running') prompt.focus();
}

function renderThread() {
  const lines = logs.get(target) ?? [];
  const who = whoIs(target);
  const controllable = target !== 'lead' && state === 'running' && who && ACTIVE.includes(who.status);
  thread.hidden = lines.length === 0 && !controllable;
  thread.innerHTML = '';
  if (controllable) {
    // Take over from a worker: pause it while you work in its window, then hand back.
    const row = add(thread, 'div', 'thread-ctl');
    add(row, 'span', '', who.paused ? `${who.name} is paused. Its window is yours.` : `Need ${who.name}'s window yourself?`);
    add(row, 'button', '', who.paused ? 'Resume' : 'Pause').addEventListener('click', () => { who.paused = !who.paused; window.swarm.pause(who.id, who.paused); renderThread(); });
    add(row, 'button', 'danger', 'Stop').addEventListener('click', () => window.swarm.stopAgent(who.id));
  }
  for (const l of lines.slice(-12)) {
    const row = add(thread, 'div', l.me ? 'line me' : 'line');
    const b = add(row, 'b', '', l.me ? 'You' : l.name);
    if (!l.me) b.style.color = whoIs(target)?.color ?? '';
    row.append(l.text);
  }
  thread.scrollTop = thread.scrollHeight;
  if (thread.hidden) recheckHit();
}

function logLine(id, line) {
  if (!logs.has(id)) logs.set(id, []);
  logs.get(id).push(line);
  if (id === target) renderThread();
  else if (!line.me) whoIs(id)?.chip?.classList.add('unread');
}

function reset() {
  for (const a of agents.values()) { a.el.classList.add('gone'); const el = a.el; setTimeout(() => el.remove(), 400); }
  agents.clear();
  logs.clear();
  usageText = '';
  // A consent request for the session that is just starting must survive the reset.
  for (const q of questions.splice(0)) { if (q.agentId === 'consent') questions.push(q); else q.el.remove(); }
  chips.innerHTML = '';
  $('card-reports').innerHTML = '';
  card.hidden = true;
  makeChip(lead);
  selectTarget('lead');
}

function spawn(info) {
  // Team mode replays a session's spawns when someone joins or reconnects, after they may already have seen
  // them live: keep the one chip and cursor per worker instead of drawing a second, frozen pair.
  const known = agents.get(info.id);
  if (known) {
    Object.assign(known, { name: info.name ?? known.name, color: info.color ?? known.color, goal: info.goal ?? known.goal });
    return;
  }
  const el = document.createElement('div');
  el.className = 'cursor gone';
  el.innerHTML = `<div class="body">${cursorSvg(info.color)}<div class="tag" style="background:${info.color}"></div></div>`;
  // Start at the prompt bar so cursors appear to fly out of it.
  el.style.transform = `translate(${window.innerWidth / 2}px, 30px)`;
  cursorsEl.append(el);
  const agent = { ...info, status: 'starting', label: '', el, chip: null, target: null, pos: { x: window.innerWidth / 2, y: 30 } };
  agents.set(info.id, agent);
  makeChip(agent);
  requestAnimationFrame(() => requestAnimationFrame(() => { el.classList.remove('gone'); placeAll(); }));
}

function toast(message, ms = 7000, tone = '') {
  const t = add(toasts, 'div', `toast ${tone}`, message);
  setTimeout(() => t.remove(), ms);
}

// ---- Questions and handoffs: one card per agent, over that agent's window ----

function makeCard(q) {
  const agent = whoIs(q.agentId);
  const el = document.createElement('div');
  el.className = 'ask hit';
  el.style.setProperty('--agent', agent?.color ?? '#ffb648');

  const head = add(el, 'div', 'ask-head');
  add(head, 'span', 'ask-who', agent?.name ?? 'Agent');
  add(head, 'span', 'ask-kind', q.kind === 'question' ? 'has a question' : q.kind === 'task' ? 'asks you to do something' : 'needs you to do something');
  const fold = add(head, 'button', 'ask-fold', 'Hide');
  fold.type = 'button';
  fold.title = 'Collapse this card so you can reach the page under it';
  fold.addEventListener('click', () => {
    fold.textContent = el.classList.toggle('folded') ? 'Show' : 'Hide';
    placeCards();
  });
  if (q.kind !== 'question') {
    // Stays visible when the card is collapsed, so you can confirm without reopening it.
    const quick = add(head, 'button', 'ask-quick', 'Done');
    quick.type = 'button';
    quick.addEventListener('click', () => send('Done'));
  }
  const body = add(el, 'div', 'ask-body');

  // Drag the card by its header to move it off whatever it covers.
  head.addEventListener('mousedown', (ev) => {
    if (ev.target.closest('button') || ev.button !== 0) return;
    const box = el.getBoundingClientRect();
    const dx = ev.clientX - box.left, dy = ev.clientY - box.top;
    dragging = true;
    el.classList.add('dragging');
    const move = (m) => {
      q.manual = {
        left: Math.max(4, Math.min(window.innerWidth - box.width - 4, m.clientX - dx)),
        top: Math.max(4, Math.min(window.innerHeight - 40, m.clientY - dy)),
      };
      placeCards();
    };
    const up = () => {
      dragging = false;
      el.classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      recheckHit();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    ev.preventDefault();
  });

  const send = (text) => { window.swarm.answer(q.qid, text); dropQuestion(q.qid); };
  const buttons = document.createElement('div');
  buttons.className = 'ask-buttons';
  const addButton = (label, value) => add(buttons, 'button', '', label).addEventListener('click', () => send(value));

  if (q.kind === 'handoff') {
    add(body, 'div', 'ask-text', q.reason);
    const steps = add(body, 'div', 'ask-steps', q.steps);
    if (q.doneWhen) add(steps, 'small', '', `It will check: ${q.doneWhen}`);
    addButton('Done', 'Done');
    addButton("I can't do this", 'The user cannot do this step. Stop this part and report.');
  } else if (q.kind === 'task') {
    // Something for the user to do elsewhere: another app, a device, the physical world.
    add(body, 'div', 'ask-text', q.task);
    if (q.where || q.doneWhen) {
      const steps = add(body, 'div', 'ask-steps', q.where ? `Where: ${q.where}` : '');
      if (q.doneWhen) add(steps, 'small', '', `Afterwards it will check: ${q.doneWhen}`);
    }
    addButton('Done', 'Done');
    addButton("I can't do this", 'The user cannot do this. Stop this part and report.');
  } else {
    add(body, 'div', 'ask-text', q.question);
    for (const opt of q.options ?? []) addButton(opt, opt);
  }
  if (buttons.children.length) body.append(buttons);

  const form = add(body, 'form', 'ask-reply');
  const input = add(form, 'input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = q.kind === 'question' ? 'Type your answer, then Enter' : q.replyHint ? `Type ${q.replyHint}, then Enter` : 'Optional note, then Enter';
  add(form, 'button', '', 'Reply').type = 'submit';
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text && q.kind === 'question') return;
    send(text || 'Done');
  });
  // Esc inside a card should not dismiss the whole overlay mid-typing.
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); input.blur(); } });

  wireHit(el);
  return el;
}

function placeCards() {
  for (const q of questions) {
    const rect = agents.get(q.agentId)?.target?.rect;
    const wantFloat = Boolean(rect || q.manual);
    const parent = wantFloat ? $('floats') : $('asks');
    if (q.el.parentElement !== parent) parent.append(q.el);   // only move when needed, to keep focus
    q.el.classList.toggle('floating', wantFloat);
    if (!wantFloat) { q.el.style.transform = ''; q.el.style.width = ''; continue; }
    const width = rect ? Math.max(280, Math.min(400, rect.w - 32)) : 360;
    q.el.style.width = q.el.classList.contains('folded') ? '' : `${width}px`;
    let left, top;
    if (q.manual) {
      ({ left, top } = q.manual);   // the user dragged it: leave it where they put it
    } else {
      // Sit along the bottom edge of the agent's window, clear of the page's main content.
      const h = q.el.offsetHeight;
      left = Math.max(8, Math.min(window.innerWidth - q.el.offsetWidth - 8, rect.x + (rect.w - q.el.offsetWidth) / 2));
      top = Math.max(8, Math.min(window.innerHeight - h - 8, rect.y + rect.h - h - 18));
    }
    q.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
}

function addQuestion(q) {
  // Team mode replays open questions when someone joins or reconnects: one card per question.
  if (q.qid != null && questions.some((x) => x.qid === q.qid)) return;
  q.el = makeCard(q);
  questions.push(q);
  placeCards();
  refreshBar();
}

function dropQuestion(qid) {
  const i = questions.findIndex((q) => q.qid === qid);
  if (i < 0) return;
  questions[i].el.remove();
  questions.splice(i, 1);
  recheckHit();
  refreshBar();
}

// ---- Prompt bar ---------------------------------------------------------------

function refreshBar() {
  dot.dataset.state = state;
  $('panel').dataset.state = state;
  const busy = state !== 'idle';
  prompt.disabled = state === 'planning';
  stop.hidden = !busy;
  resetBtn.hidden = busy || !(agents.size || [...logs.values()].some((l) => l.length) || !card.hidden);
  go.hidden = state === 'planning';
  if (state === 'idle') {
    go.textContent = 'Run';
    prompt.disabled = !modeChosen || (team.on && team.account !== 'signed_in');
    go.hidden = prompt.disabled;
    prompt.placeholder = !modeChosen ? 'Choose how to work to start' : team.on && team.account !== 'signed_in' ? 'Sign in to your team to start'
      : (demo ? 'Demo mode: type anything and press Enter' : agents.size ? 'Done. What next?' : 'What should the swarm do?');
  } else if (state === 'planning') {
    prompt.placeholder = 'Starting...';
  } else {
    go.textContent = 'Send';
    const name = whoIs(target)?.name ?? 'Lead';
    const needs = questions.length ? `${questions.length} agent${questions.length > 1 ? 's need' : ' needs'} you (see cards). ` : '';
    prompt.placeholder = `${needs}Message ${name === 'Lead' ? 'the lead' : name}. Click an agent to switch.`;
  }
}

function setState(next) {
  state = next;
  if (next === 'idle') {
    for (const q of questions.splice(0)) q.el.remove();
    recheckHit();
    prompt.value = '';
    if (overHit || document.hasFocus()) prompt.focus();
  }
  refreshBar();
  placeAll();
  renderThread();
}

// ---- Each launch: work on this Mac, or with the team ----------------------------------------------
let modeChosen = false;
function renderModeChoice(last) {
  const box = $('account');
  box.hidden = false;
  box.innerHTML = '';
  add(box, 'div', 'acct-title', 'How do you want to work this time?');
  const row = add(box, 'div', 'mode-choice');
  const options = [
    ['local', 'On this Mac', 'No account. Agents run here on your own API key.'],
    ['team', 'With my team', 'Sign in. Share a session across your team\'s computers.'],
  ];
  if (last === 'team') options.reverse();   // the one used last time comes first
  const buttons = options.map(([mode, title, note]) => {
    const b = add(row, 'button', '');
    add(b, 'b', '', title);
    add(b, 'span', '', note);
    b.addEventListener('click', () => window.swarm.setMode(mode));
    return b;
  });
  add(box, 'div', 'acct-note', 'You can switch later from the menu bar icon.');
  recheckHit();
  buttons[0].focus();
}

// ---- Team mode: account, consent, people ---------------------------------------------------------

function renderAccount(e) {
  const box = $('account');
  team.account = e.state;
  team.url = e.url ?? team.url;
  if (e.state === 'signed_in') {
    team.user = e.user.id; team.name = e.team.name; team.device = e.device.id;
    box.hidden = true;
    box.innerHTML = '';
    recheckHit();
    return refreshBar();
  }
  box.hidden = false;
  box.innerHTML = '';
  if (e.state === 'signed_out') {
    add(box, 'div', 'acct-title', 'Sign in to your team');
    const form = add(box, 'form', 'acct-form');
    const email = add(form, 'input'); email.type = 'email'; email.placeholder = 'Email'; email.required = true;
    const pass = add(form, 'input'); pass.type = 'password'; pass.placeholder = 'Password'; pass.required = true;
    add(form, 'button', '', 'Sign in').type = 'submit';
    form.addEventListener('submit', (ev) => { ev.preventDefault(); window.swarm.signIn(email.value.trim(), pass.value); });
    for (const input of [email, pass]) input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') ev.stopPropagation(); });
    add(box, 'div', 'acct-note', `No account yet? Create one at ${team.url}`);
  } else if (e.state === 'no_team') {
    add(box, 'div', 'acct-title', 'You are not in a team yet');
    add(box, 'div', 'acct-note', `Create or join one at ${team.url}, then restart this app.`);
  } else {
    add(box, 'div', 'acct-title', 'Reconnecting to your team...');
  }
  if (e.error) add(box, 'div', 'acct-error', e.error);
  refreshBar();
}

// Solo mode with no API key yet: ask for it once, store it, then run what was asked.
let goalWaitingForKey = null;
function renderKeyPrompt(e) {
  const box = $('account');
  if (e.goal) goalWaitingForKey = e.goal;
  box.hidden = false;
  box.innerHTML = '';
  add(box, 'div', 'acct-title', 'Add your Ripple B200 server key');
  const form = add(box, 'form', 'acct-form');
  const input = add(form, 'input'); input.type = 'password'; input.placeholder = 'B200 server key'; input.required = true; input.autocomplete = 'off';
  add(form, 'button', '', 'Save').type = 'submit';
  form.addEventListener('submit', (ev) => { ev.preventDefault(); window.swarm.saveKey(input.value.trim()); });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') ev.stopPropagation(); });
  add(box, 'div', 'acct-note', 'Agents run on your own key. It is encrypted with your Mac\'s keychain and stays on this computer.');
  if (e.error) add(box, 'div', 'acct-error', e.error);
  input.focus();
}

// Someone's session wants to use this computer. Nothing here runs for them until you allow it.
function consentCard(session) {
  const qid = `consent-${session.id}`;
  if (questions.some((q) => q.qid === qid)) return;
  const el = document.createElement('div');
  el.className = 'ask hit';
  const head = add(el, 'div', 'ask-head');
  add(head, 'span', 'ask-who', session.owner.name);
  add(head, 'span', 'ask-kind', 'wants to use this Mac');
  add(el, 'div', 'ask-text', session.goal);
  add(el, 'div', 'ask-steps', 'If you allow it, agents in this session can use the apps and tools this Mac offers, for this session only. You will still be asked before anything is sent in your name. "Just watch" lets you follow along and talk to the lead without lending this Mac.');
  const buttons = add(el, 'div', 'ask-buttons');
  const decide = (allow, watch = false) => { window.swarm.consent(allow, watch); dropQuestion(qid); };
  add(buttons, 'button', '', 'Allow for this session').addEventListener('click', () => decide(true));
  add(buttons, 'button', '', 'Just watch').addEventListener('click', () => decide(false, true));
  add(buttons, 'button', '', 'Not now').addEventListener('click', () => decide(false));
  wireHit(el);
  questions.push({ qid, agentId: 'consent', el });
  placeCards();
}

function renderPeople(people, session = null) {
  team.people = people;
  const line = $('people');
  line.innerHTML = '';
  if (!team.on || people.length === 0) return;
  // A teammate's session is running and you are not part of it: you see where its agents are, nothing more.
  const me = people.find((p) => p.id === team.user);
  if (session && me && !me.joined) {
    const join = add(line, 'button', 'person join hit', `Join ${session.owner.name}'s session`);
    join.title = 'See the conversation and talk to the lead. This does not share your Mac.';
    join.addEventListener('click', () => window.swarm.join());
    wireHit(join);
  }
  for (const p of people) {
    const tag = add(line, 'span', 'person', p.id === team.user ? `${p.name} (you)` : p.name);
    const here = p.devices.filter((d) => d.inSession).length;
    tag.title = p.devices.length ? p.devices.map((d) => `${d.name}${d.inSession ? ': in session' : d.asked ? ': asked to join' : ''}`).join('\n') : 'On the web';
    if (here) tag.classList.add('in');
  }
}

window.swarm.onEvent((e) => {
  switch (e.type) {
    case 'summon':
      demo = Boolean(e.demo);
      team.on = Boolean(e.team);
      if (e.hotkey) {
        returnKey = e.hotkey;
        $('dismiss').title = `Hide (Esc). ${returnKey} brings it back. A running job keeps going.`;
      }
      modeChosen = Boolean(e.mode);
      refreshBar();
      if (modeChosen) prompt.focus(); else renderModeChoice(e.lastMode);
      break;
    case 'mode':
      // The way of working was chosen or switched: start from a clean bar.
      modeChosen = true;
      team.on = Boolean(e.team);
      if (!team.on) team.account = 'solo';
      reset();
      renderPeople([]);
      $('account').hidden = true;
      $('account').innerHTML = '';
      recheckHit();
      refreshBar();
      if (!prompt.disabled) prompt.focus();
      break;
    case 'reset': reset(); refreshBar(); recheckHit(); break;
    case 'account': renderAccount(e); break;
    case 'need_key': renderKeyPrompt(e); break;
    case 'key_saved': {
      $('account').hidden = true;
      $('account').innerHTML = '';
      recheckHit();
      if (goalWaitingForKey) { window.swarm.submit(goalWaitingForKey); goalWaitingForKey = null; }
      break;
    }
    case 'consent': consentCard(e.session); break;
    case 'presence': renderPeople(e.people, e.session); break;
    case 'session': team.owner = e.owner; break;
    case 'said': logLine(e.target, { me: e.from.id === team.user, name: e.from.name, text: e.text }); break;
    case 'remembered': toast(`Remembered for ${e.scope === 'team' ? 'the team' : e.person}: ${e.note}`, 7000, 'info'); break;
    case 'state': setState(e.state); break;
    case 'spawn': spawn(e.agent); break;
    case 'lead': lead.status = e.status; setChip(lead, e.status, e.label); break;
    case 'agent': {
      const a = agents.get(e.id);
      if (!a) break;
      const wasActive = ACTIVE.includes(a.status);
      a.status = e.status; a.label = e.label;
      if (e.device) { a.device = e.device; a.deviceName = e.deviceName; }
      if (e.status !== 'waiting') a.waitingFor = null;
      if (e.paused != null) a.paused = e.paused;
      setChip(a, e.status, e.label);
      placeAll();
      if (e.id === target && wasActive !== ACTIVE.includes(a.status)) renderThread();
      break;
    }
    case 'cursor': { const a = agents.get(e.agentId); if (a) playCursor(a, e); break; }
    case 'targets':
      for (const [id, t] of Object.entries(e.targets)) { const a = agents.get(id); if (a) a.target = t; }
      placeAll();
      break;
    case 'usage': {
      const total = e.input + e.output + e.cacheRead + e.cacheWrite;
      const fmt = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
      usageText = `${fmt(total)} tokens processed over ${e.calls} model calls (${fmt(e.cacheRead)} read from cache, ${fmt(e.output)} written)`;
      if (lead.chip) lead.chip.title = `Lead agent: plans, supervises, replans. Click to chat.\n${usageText}`;
      break;
    }
    case 'chat': logLine(e.from, { me: false, name: e.name, text: e.text }); break;
    case 'ask': {
      // Team mode: a request tied to someone else's computer shows there, not here.
      if (team.on && e.audience && e.audience.deviceId !== team.device) {
        const a = agents.get(e.agentId);
        if (a) { a.waitingFor = e.audience.userName; setChip(a, a.status, a.label); }
        break;
      }
      addQuestion(e);
      break;
    }
    case 'answered': dropQuestion(e.qid); break;
    case 'result': {
      const a = agents.get(e.id);
      const p = add($('card-reports'), 'p');
      add(p, 'b', '', `${a?.name ?? e.id}: `);
      p.append(e.text);
      break;
    }
    case 'done':
      $('card-summary').textContent = e.summary;
      $('card-usage').textContent = usageText;
      $('card-details').hidden = agents.size === 0;
      card.hidden = false;
      break;
    case 'skill': toast(`${e.created ? 'Learned a new skill' : 'Improved a skill'}: ${e.name}`, 8000, 'info'); break;
    case 'error': toast(e.message); break;
    case 'notice': toast(e.message, e.tone === 'info' ? 2500 : 5000, e.tone ?? ''); break;
  }
});

bar.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = prompt.value.trim();
  if (!text) return;
  if (state === 'idle') {
    window.swarm.submit(text);
  } else if (state === 'running') {
    window.swarm.tell(text, target);
    if (!team.on) logLine(target, { me: true, text });   // in a team the hub echoes it to everyone
  }
  prompt.value = '';
});
stop.addEventListener('click', () => window.swarm.cancel());
// Back to a fresh bar: the app clears its side (last job, leftover windows), and says reset.
resetBtn.addEventListener('click', () => { if (state === 'idle') window.swarm.reset(); });
$('dismiss').addEventListener('click', () => window.swarm.dismiss());
$('open-app').addEventListener('click', () => window.swarm.openApp());
$('card-close').addEventListener('click', () => { card.hidden = true; recheckHit(); refreshBar(); });
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') window.swarm.dismiss(); });
window.addEventListener('resize', placeAll);
new ResizeObserver(placeAll).observe($('dock'));
