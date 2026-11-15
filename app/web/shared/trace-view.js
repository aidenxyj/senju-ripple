// The session viewer, shared by the desktop launcher and the web control page.
//
// A session reads top to bottom like a chat, one block per turn:
//   your message → a swimlane strip (who worked when) → the lead's story, with each worker's card
//   placed where the lead started it → the turn's summary.
// A worker card lists its steps the way a coding agent lists tool calls: "● click  Sign in", with the
// result underneath when it is available (personal sessions only; team history never stores results).
//
//   const view = createTraceView(el, { showResults: true });
//   view.load(session, rows);     // session: { title, turns: [{goal, ownerName, started, ended, status, summary, usage}] }
//   view.push(row);               // rows: { turn, at, event } — live events as they happen
//
// No dependencies, no innerHTML: every string from a session is set as text.

const LOOK = /(^|_)(snapshot|screenshot|get_window_state|list_windows|get_browser_state|evaluate|read|state|wait_for|wait)$/;
const LEAD_HIDDEN = new Set(['wait', 'board_read', 'read_skill']);

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
const add = (parent, tag, cls, text) => parent.appendChild(el(tag, cls, text));
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t));
function dur(a, b) {
  const s = Math.max(0, Math.round((ms(b) - ms(a)) / 1000));
  if (!Number.isFinite(s)) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const clock = (t) => { const d = new Date(ms(t)); return Number.isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const fmtTokens = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0);

// "browser_james-mac__browser_click" → { verb: 'click', server: 'browser' }
export function toolParts(name) {
  const full = String(name ?? '');
  const i = full.lastIndexOf('__');
  const server = i > 0 ? full.slice(0, i).split(/[_@]/)[0] : '';
  const verb = (i > 0 ? full.slice(i + 2) : full).replace(/^browser_/, '').replace(/_/g, ' ');
  return { verb, server };
}

function newTurn(index, meta = {}) {
  return {
    index, goal: meta.goal ?? '', by: meta.ownerName ?? null, started: meta.started ?? null, ended: meta.ended ?? null,
    status: meta.status ?? null, summary: meta.summary ?? null, usage: meta.usage ?? null, costMicro: meta.costMicro ?? null,
    flow: [],            // in time order: { kind: 'lead'|'said'|'agent'|'board'|'memo'|'ask'|'error', ... }
    agents: new Map(),   // id -> worker
    leadSteps: [],
    first: null, last: null,
  };
}

export function createTraceView(root, { showResults = false } = {}) {
  root.classList.add('tv');
  const state = { session: null, turns: [], showResults, filter: 'all', open: new Set(), raf: 0, dirty: new Set() };
  const turnsEl = el('div', 'tv-turns');
  const bar = el('div', 'tv-bar');
  root.replaceChildren(bar, turnsEl);

  function turnAt(i) {
    while (state.turns.length <= i) state.turns.push(newTurn(state.turns.length, state.session?.turns?.[state.turns.length]));
    return state.turns[i];
  }

  function apply(row) {
    const t = turnAt(row.turn ?? 0);
    const e = row.event;
    const at = e.at ?? row.at ?? Date.now();
    t.first ??= at;
    t.last = at;
    const agent = (id) => t.agents.get(id);
    switch (e.type) {
      case 'session':
        t.goal ||= e.goal ?? '';
        t.by ||= e.owner?.name ?? null;
        t.started ||= row.at;
        break;
      case 'said':
        t.flow.push({ kind: 'said', at, name: e.from?.name ?? 'You', text: e.text, target: e.target });
        break;
      case 'spawn': {
        const a = { id: e.agent.id, name: e.agent.name, color: e.agent.color ?? '#888', goal: e.agent.goal ?? '', dependsOn: e.agent.dependsOn ?? [], status: 'starting', label: '', deviceName: null, steps: [], report: null, first: at, last: at };
        t.agents.set(a.id, a);
        t.flow.push({ kind: 'agent', at, id: a.id });
        break;
      }
      case 'agent': {
        const a = agent(e.id);
        if (!a) break;
        a.status = e.status ?? a.status;
        a.label = e.label ?? a.label;
        if (e.deviceName) a.deviceName = e.deviceName;
        a.last = at;
        break;
      }
      case 'step': {
        if (e.agentId === 'lead') {
          const parts = toolParts(e.tool);
          if (e.kind === 'say') t.flow.push({ kind: 'lead', at, text: e.text });
          else if (!LEAD_HIDDEN.has(parts.verb.replace(/ /g, '_')) && e.tool !== 'spawn_agent') t.flow.push({ kind: 'leadtool', at, tool: e.tool, label: e.label });
          t.leadSteps.push(at);
          break;
        }
        const a = agent(e.agentId);
        if (!a) break;
        a.steps.push({ ...e, at });
        if (e.deviceName) a.deviceName = e.deviceName;
        a.last = at;
        break;
      }
      case 'chat':
        if (e.from === 'lead') {
          const lastLead = [...t.flow].reverse().find((f) => f.kind === 'lead');
          if (!lastLead || lastLead.text !== e.text) t.flow.push({ kind: 'lead', at, text: e.text });
        } else {
          const a = agent(e.from);
          if (a) a.steps.push({ kind: 'reply', text: e.text, at });
        }
        break;
      case 'ask': {
        const item = { kind: 'ask', at, qid: e.qid, ask: e, answer: null, agentId: e.agentId };
        const a = agent(e.agentId);
        if (a) a.steps.push(item); else t.flow.push(item);
        break;
      }
      case 'answered': {
        const all = [...t.flow, ...[...t.agents.values()].flatMap((a) => a.steps)];
        const item = all.find((s) => s.kind === 'ask' && s.qid === e.qid);
        if (item) item.answer = { text: e.text ?? null, by: e.by ?? null, at };
        break;
      }
      case 'result': { const a = agent(e.id); if (a) { a.report = e.text; a.last = at; } break; }
      case 'board': t.flow.push({ kind: 'board', at, from: e.from, text: e.note }); break;
      case 'remembered': t.flow.push({ kind: 'memo', at, text: `Remembered${e.person ? ` for ${e.scope === 'team' ? 'the team' : e.person}` : ''}: ${e.note}` }); break;
      case 'skill': t.flow.push({ kind: 'memo', at, text: `${e.created ? 'Learned a new skill' : 'Improved a skill'}: ${e.name}${e.revision > 1 ? ` (revision ${e.revision})` : ''}` }); break;
      case 'done': t.summary = e.summary; t.status = 'done'; t.ended ||= at; break;
      case 'error': t.flow.push({ kind: 'error', at, text: e.message }); t.status ||= 'stopped'; t.ended ||= at; break;
      case 'state': if (e.state === 'idle') t.ended ||= at; if (e.state === 'running' || e.state === 'planning') t.status = t.status === 'done' ? t.status : 'running'; break;
      default: break;
    }
    return t.index;
  }

  // ---- Rendering ----

  function stepRow(s, a) {
    if (s.kind === 'say') return el('p', 'tv-say', s.text);
    if (s.kind === 'reply') { const p = el('p', 'tv-say tv-reply'); add(p, 'b', null, 'Replied: '); p.append(s.text); return p; }
    if (s.kind === 'ask') return askBox(s);
    const { verb } = toolParts(s.tool);
    const row = el('div', `tv-step${s.isError ? ' err' : ''}${LOOK.test(verb.replace(/ /g, '_')) ? ' look' : ''}`);
    const head = add(row, 'div', 'tv-step-head');
    const dot = add(head, 'i', 'tv-dot');
    dot.style.background = s.isError ? 'var(--danger)' : a?.color ?? 'var(--ink)';
    add(head, 'span', 'tv-verb', verb);
    if (s.label) add(head, 'span', 'tv-label', s.label);
    if (s.ms > 1500) add(head, 'span', 'tv-ms', dur(0, s.ms));
    if (state.showResults && s.result) {
      const res = add(row, 'div', 'tv-result');
      add(res, 'span', 'tv-elbow', '⎿');
      const body = add(res, 'span', 'tv-result-text', s.result);
      res.addEventListener('click', () => body.classList.toggle('full'));
    }
    return row;
  }

  // Runs of look-only steps (snapshots, window reads) fold into one quiet line.
  function stepList(steps, a) {
    const out = [];
    let looks = [];
    const flush = () => {
      if (looks.length === 1) out.push(stepRow(looks[0], a));
      else if (looks.length > 1) { const n = el('div', 'tv-step look folded'); const h = add(n, 'div', 'tv-step-head'); add(h, 'i', 'tv-dot').style.background = 'var(--line-strong)'; add(h, 'span', 'tv-verb', `looked ${looks.length}×`); out.push(n); }
      looks = [];
    };
    for (const s of steps) {
      const quiet = s.kind === 'tool' && !s.isError && LOOK.test(toolParts(s.tool).verb.replace(/ /g, '_')) && !(state.showResults);
      if (quiet) { looks.push(s); continue; }
      flush();
      out.push(stepRow(s, a));
    }
    flush();
    return out;
  }

  function askBox(item) {
    const box = el('div', 'tv-ask');
    const e = item.ask;
    const kind = e.kind === 'question' ? 'Asked' : e.kind === 'task' ? 'Asked you to do' : 'Needed you to';
    add(box, 'div', 'tv-ask-kind', e.redacted ? `Needed ${e.audience?.userName ?? 'someone'} at their computer` : kind);
    if (!e.redacted) add(box, 'div', 'tv-ask-text', e.question ?? e.task ?? e.reason ?? '');
    if (item.answer) {
      const ans = add(box, 'div', 'tv-ask-answer');
      add(ans, 'b', null, item.answer.by ? `${item.answer.by}: ` : 'Answer: ');
      ans.append(item.answer.text ?? 'answered');
    } else add(box, 'div', 'tv-ask-answer dim', 'waiting for an answer');
    return box;
  }

  function workerCard(t, a) {
    const key = `${t.index}:${a.id}`;
    const live = ['acting', 'thinking', 'starting', 'waiting', 'blocked', 'paused'].includes(a.status) && t.status === 'running';
    const open = state.open.has(key) || (live && !state.open.has(`${key}:closed`));
    const card = el('section', `tv-card${live ? ' live' : ''}${open ? ' open' : ''}`);
    card.id = `tv-${t.index}-${a.id}`;
    card.style.setProperty('--agent', a.color);
    const head = add(card, 'header', 'tv-card-head');
    add(head, 'i', 'tv-swatch');
    const title = add(head, 'div', 'tv-card-title');
    add(title, 'b', null, a.name);
    add(title, 'span', 'tv-card-goal', a.goal);
    const meta = add(head, 'div', 'tv-card-meta');
    if (a.deviceName) add(meta, 'span', 'pill', `on ${a.deviceName}`);
    const status = a.status === 'done' ? 'done' : a.status === 'error' ? 'error' : a.status === 'cancelled' ? 'stopped' : live ? 'live' : a.status;
    add(meta, 'span', `pill ${status}`, status === 'live' ? (a.status === 'waiting' ? 'needs you' : a.status) : status);
    const tools = a.steps.filter((s) => s.kind === 'tool').length;
    add(meta, 'span', 'tv-count', `${tools} step${tools === 1 ? '' : 's'} · ${dur(a.first, a.last)}`);
    head.addEventListener('click', () => {
      if (open) { state.open.delete(key); state.open.add(`${key}:closed`); } else { state.open.add(key); state.open.delete(`${key}:closed`); }
      draw(t.index);
    });
    const body = add(card, 'div', 'tv-card-body');
    const steps = open ? a.steps : a.steps.slice(-3);
    if (!open && a.steps.length > 3) add(body, 'div', 'tv-more', `${a.steps.length - 3} earlier · click to see all`);
    body.append(...stepList(steps, a));
    if (live && a.label) add(body, 'div', 'tv-now', a.label);
    if (a.report) { const q = add(body, 'blockquote', 'tv-report'); add(q, 'b', null, 'Report'); add(q, 'p', null, a.report); }
    return card;
  }

  function swimlanes(t) {
    const agents = [...t.agents.values()];
    if (!agents.length || !t.first) return null;
    const start = ms(t.first), end = Math.max(ms(t.last ?? t.first), ...agents.map((a) => ms(a.last)), start + 1000);
    const span = end - start;
    const box = el('div', 'tv-lanes');
    const lane = (name, color, from, to, ticks, id) => {
      const row = add(box, 'div', 'tv-lane');
      add(row, 'span', 'tv-lane-name', name);
      const track = add(row, 'div', 'tv-track');
      const barEl = add(track, 'i', 'tv-span');
      barEl.style.left = `${((ms(from) - start) / span) * 100}%`;
      barEl.style.width = `${Math.max(0.6, ((ms(to) - ms(from)) / span) * 100)}%`;
      barEl.style.background = color;
      for (const tk of ticks) {
        const m = add(track, 'i', `tv-tick${tk.err ? ' err' : ''}${tk.ask ? ' ask' : ''}`);
        m.style.left = `${((ms(tk.at) - start) / span) * 100}%`;
      }
      if (id) row.addEventListener('click', () => { state.open.add(`${t.index}:${id}`); draw(t.index); root.querySelector(`#tv-${t.index}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    };
    lane('Lead', 'var(--ink)', t.first, t.last ?? t.first, t.leadSteps.map((at) => ({ at })), null);
    for (const a of agents) {
      if (state.filter !== 'all' && state.filter !== a.id) continue;
      lane(a.name, a.color, a.first, a.last, a.steps.filter((s) => s.kind === 'tool' || s.kind === 'ask').map((s) => ({ at: s.at, err: s.isError, ask: s.kind === 'ask' })), a.id);
    }
    const foot = add(box, 'div', 'tv-lanes-foot');
    add(foot, 'span', null, clock(t.first));
    add(foot, 'span', null, dur(t.first, end));
    add(foot, 'span', null, clock(end));
    return box;
  }

  function drawTurn(t) {
    const sec = el('article', 'tv-turn');
    sec.dataset.turn = t.index;
    const you = add(sec, 'div', 'tv-you');
    const bubble = add(you, 'div', 'tv-bubble');
    add(bubble, 'p', null, t.goal || '(no message)');
    add(you, 'div', 'tv-you-meta', `${t.by ?? 'You'}${t.started ? ` · ${clock(t.started)}` : ''}${t.index > 0 ? ' · continued' : ''}`);
    const lanes = swimlanes(t);
    if (lanes) sec.append(lanes);
    const flow = add(sec, 'div', 'tv-flow');
    for (const f of t.flow) {
      if (state.filter !== 'all' && f.kind !== 'agent' && state.filter !== 'lead') continue;
      if (f.kind === 'lead') {
        if (t.summary && f.text.trim() === String(t.summary).trim()) continue;   // the final reply is the summary below
        const p = add(flow, 'div', 'tv-lead'); add(p, 'span', 'tv-who', 'Lead'); add(p, 'p', null, f.text);
      }
      else if (f.kind === 'leadtool') { const { verb } = toolParts(f.tool); const p = add(flow, 'div', 'tv-leadtool'); add(p, 'span', 'tv-verb', verb); if (f.label) add(p, 'span', 'tv-label', f.label); }
      else if (f.kind === 'said') { const p = add(flow, 'div', 'tv-said'); add(p, 'b', null, `${f.name}${f.target && f.target !== 'lead' ? ` → ${t.agents.get(f.target)?.name ?? 'a worker'}` : ''}: `); p.append(f.text); }
      else if (f.kind === 'agent') { const a = t.agents.get(f.id); if (a && (state.filter === 'all' || state.filter === a.id)) flow.append(workerCard(t, a)); }
      else if (f.kind === 'board') { const p = add(flow, 'div', 'tv-board'); add(p, 'b', null, `${f.from} on the board: `); p.append(f.text); }
      else if (f.kind === 'memo') add(flow, 'div', 'tv-memo', f.text);
      else if (f.kind === 'ask') flow.append(askBox(f));
      else if (f.kind === 'error') add(flow, 'div', 'tv-error', f.text);
    }
    if (t.summary || t.status === 'stopped') {
      const done = add(sec, 'div', `tv-summary ${t.status === 'done' ? '' : 'stopped'}`);
      add(done, 'div', 'tv-summary-kicker', t.status === 'done' ? 'Done' : 'Stopped');
      add(done, 'p', null, t.summary ?? 'This turn ended before it finished.');
      const facts = [];
      if (t.first && t.ended) facts.push(dur(t.started ?? t.first, t.ended));
      if (t.agents.size) facts.push(`${t.agents.size} worker${t.agents.size === 1 ? '' : 's'}`);
      const u = t.usage;
      if (u) facts.push(`${fmtTokens((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0))} tokens`);
      if (t.costMicro) facts.push(`$${(t.costMicro / 1e6).toFixed(2)}`);
      if (facts.length) add(done, 'div', 'tv-summary-facts', facts.join(' · '));
    } else if (t.status === 'running') {
      add(sec, 'div', 'tv-working', 'Working…');
    }
    return sec;
  }

  function drawBar() {
    bar.replaceChildren();
    const ids = new Map();
    for (const t of state.turns) for (const a of t.agents.values()) if (!ids.has(a.id + a.name)) ids.set(a.id + a.name, a);
    const chips = add(bar, 'div', 'tv-filters');
    const chip = (id, label, color) => {
      const b = add(chips, 'button', `tv-filter${state.filter === id ? ' on' : ''}`);
      if (color) add(b, 'i', 'tv-dot').style.background = color;
      b.append(label);
      b.addEventListener('click', () => { state.filter = id; drawAll(); });
    };
    chip('all', 'Everyone');
    chip('lead', 'Lead', 'var(--ink)');
    for (const a of ids.values()) chip(a.id, a.name, a.color);
    const tools = add(bar, 'div', 'tv-tools');
    if (state.canShowResults) {
      const lab = add(tools, 'label', 'tv-toggle');
      const box = add(lab, 'input');
      box.type = 'checkbox';
      box.checked = state.showResults;
      box.addEventListener('change', () => { state.showResults = box.checked; drawAll(); });
      lab.append('Tool results');
    }
    const all = add(tools, 'button', 'tv-filter', state.expandAll ? 'Collapse all' : 'Expand all');
    all.addEventListener('click', () => {
      state.expandAll = !state.expandAll;
      for (const t of state.turns) for (const a of t.agents.values()) { const k = `${t.index}:${a.id}`; if (state.expandAll) { state.open.add(k); state.open.delete(`${k}:closed`); } else { state.open.delete(k); state.open.add(`${k}:closed`); } }
      drawAll();
    });
  }

  function drawAll() {
    drawBar();
    turnsEl.replaceChildren(...state.turns.map(drawTurn));
    if (!state.turns.length) add(turnsEl, 'div', 'tv-empty', 'Nothing here yet.');
  }

  function draw(i) {
    const old = turnsEl.querySelector(`[data-turn="${i}"]`);
    const fresh = drawTurn(state.turns[i]);
    if (old) old.replaceWith(fresh); else turnsEl.append(fresh);
  }

  const nearBottom = () => { const s = root.closest('.tv-scroll') ?? root; return s.scrollHeight - s.scrollTop - s.clientHeight < 140; };

  return {
    load(session, rows = [], opts = {}) {
      state.session = session;
      state.turns = [];
      state.open.clear();
      state.canShowResults = opts.canShowResults ?? state.showResults;
      for (let i = 0; i < (session?.turns?.length ?? 0); i++) turnAt(i);
      for (const r of rows) apply(r);
      // Facts from the saved turn win over what events implied.
      session?.turns?.forEach((meta, i) => Object.assign(state.turns[i], Object.fromEntries(Object.entries({ goal: meta.goal, by: meta.ownerName, started: meta.started, ended: meta.ended, status: meta.status === 'running' ? 'running' : meta.status, summary: meta.summary, usage: meta.usage, costMicro: meta.costMicro }).filter(([, v]) => v != null))));
      drawAll();
    },
    push(row) {
      const stick = nearBottom();
      const i = apply(row);
      state.dirty.add(i);
      if (state.raf) return;
      state.raf = requestAnimationFrame(() => {
        state.raf = 0;
        const newAgent = row.event.type === 'spawn';
        if (newAgent) drawBar();
        for (const d of state.dirty) draw(d);
        state.dirty.clear();
        if (stick) { const s = root.closest('.tv-scroll') ?? root; s.scrollTop = s.scrollHeight; }
      });
    },
    // A new turn is about to start (the person sent a message): show it straight away.
    startTurn(goal, by) {
      const t = turnAt(state.turns.length);
      Object.assign(t, { goal, by, started: new Date().toISOString(), status: 'running' });
      draw(t.index);
      return t.index;
    },
    get turnCount() { return state.turns.length; },
  };
}
