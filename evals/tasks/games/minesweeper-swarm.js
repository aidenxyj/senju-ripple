// Game, swarm: four Minesweeper boards, each on its own local site, played at the same time (one worker per board
// is the natural plan, so the demo shows four cursors). No vision needed: every cell is a labelled button, and the
// page also prints the board as text. Each board is generated from a fixed seed and checked at load time to be
// solvable by logic alone from its opening, so a lost board is the model's mistake, not bad luck.
// Pass: every board won. A clicked mine ends that board for good.
import { serve, page, esc } from '../../lib/site.mjs';

const SIZE = 9;
const MINES = 10;
const START = [4, 4];          // opened for the player at setup; mines never touch it, so it is a 0 with an opening
const BOARD_COUNT = 4;

function rng(seed) {   // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const near = (r, c) => { const out = []; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
  const rr = r + dr, cc = c + dc; if ((dr || dc) && rr >= 0 && cc >= 0 && rr < SIZE && cc < SIZE) out.push([rr, cc]); } return out; };

function layMines(seed) {
  const rand = rng(seed);
  const mines = new Set();
  const banned = new Set([START, ...near(...START)].map(([r, c]) => r * SIZE + c));
  while (mines.size < MINES) { const k = Math.floor(rand() * SIZE * SIZE); if (!banned.has(k)) mines.add(k); }
  return mines;
}

// Logic-only solver over the text board ('#' hidden, 'F' flag, '.' or 1-8 revealed). Returns the cells it can prove
// safe and the cells it can prove are mines. Uses the single-cell rules plus the subset rule between two numbers.
// It is self-contained on purpose: the stub ships its source into the browser.
export function solveStep(rows) {
  const N = rows.length, M = rows[0].length;
  const at = (r, c) => rows[r][c];
  const nb = (r, c) => { const o = []; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const x = r + a, y = c + b;
    if ((a || b) && x >= 0 && y >= 0 && x < N && y < M) o.push([x, y]); } return o; };
  const safe = new Map(), mine = new Map();
  const cons = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < M; c++) {
    const ch = at(r, c); if (!/[1-8.]/.test(ch)) continue;
    const n = ch === '.' ? 0 : Number(ch);
    const hidden = nb(r, c).filter(([x, y]) => at(x, y) === '#');
    const flags = nb(r, c).filter(([x, y]) => at(x, y) === 'F').length;
    if (!hidden.length) continue;
    cons.push({ cells: new Set(hidden.map(([x, y]) => x * M + y)), need: n - flags });
  }
  for (const k of cons) {
    if (k.need === 0) for (const v of k.cells) safe.set(v, 1);
    if (k.need === k.cells.size) for (const v of k.cells) mine.set(v, 1);
  }
  for (const a of cons) for (const b of cons) {
    if (a === b || a.cells.size >= b.cells.size || ![...a.cells].every((v) => b.cells.has(v))) continue;
    const rest = [...b.cells].filter((v) => !a.cells.has(v));
    const need = b.need - a.need;
    if (need === 0) for (const v of rest) safe.set(v, 1);
    if (need === rest.length) for (const v of rest) mine.set(v, 1);
  }
  const cell = (v) => [Math.floor(v / M), v % M];
  return { safe: [...safe.keys()].map(cell), mines: [...mine.keys()].map(cell) };
}

// A board game: server-side state plus the text view the page shows.
function newGame(mines) {
  const g = { mines, open: new Set(), flags: new Set(), status: 'playing', clicks: 0 };
  const count = (r, c) => near(r, c).filter(([x, y]) => mines.has(x * SIZE + y)).length;
  g.reveal = (r, c) => {
    const k = r * SIZE + c;
    if (g.status !== 'playing' || g.open.has(k) || g.flags.has(k)) return;
    g.clicks++;
    if (mines.has(k)) { g.status = 'lost'; g.boom = k; return; }
    const stack = [[r, c]];
    while (stack.length) { const [x, y] = stack.pop(); const kk = x * SIZE + y; if (g.open.has(kk)) continue;
      g.open.add(kk); g.flags.delete(kk); if (count(x, y) === 0) for (const n of near(x, y)) if (!g.open.has(n[0] * SIZE + n[1])) stack.push(n); }
    if (g.open.size === SIZE * SIZE - MINES) g.status = 'won';
  };
  g.flag = (r, c) => { const k = r * SIZE + c; if (g.status !== 'playing' || g.open.has(k)) return; g.flags.has(k) ? g.flags.delete(k) : g.flags.add(k); };
  g.char = (r, c) => { const k = r * SIZE + c;
    if (g.status === 'lost' && mines.has(k)) return '*';
    if (g.open.has(k)) { const n = count(r, c); return n ? String(n) : '.'; }
    return g.flags.has(k) ? 'F' : '#'; };
  g.rows = () => Array.from({ length: SIZE }, (_, r) => Array.from({ length: SIZE }, (_, c) => g.char(r, c)).join(''));
  return g;
}

function solvable(mines) {
  const g = newGame(mines);
  g.reveal(...START);
  for (let i = 0; i < 200 && g.status === 'playing'; i++) {
    const { safe, mines: m } = solveStep(g.rows());
    if (!safe.length && !m.length) return false;
    for (const [r, c] of m) if (!g.flags.has(r * SIZE + c)) g.flag(r, c);
    for (const [r, c] of safe) g.reveal(r, c);
  }
  return g.status === 'won';
}

// Pick BOARD_COUNT seeds, deterministically, whose boards are logic-solvable, searching up from `from`.
function pickSeeds(from) {
  const seeds = [];
  for (let s = from; seeds.length < BOARD_COUNT; s++) if (solvable(layMines(s))) seeds.push(s);
  return seeds;
}
// The default boards, done once at import. A run with ctx.seed (a variant, for evals/research/) searches from
// 1000 + ctx.seed * 100 instead.
const SEEDS = pickSeeds(1000);
const seedsFor = (seed) => (Number.isFinite(seed) ? pickSeeds(1000 + seed * 100) : SEEDS);

const LABEL = { '#': 'hidden', F: 'flagged', '.': 'empty', '*': 'mine' };

function app(game, n) {
  return async ({ method, path: p, body }) => {
    if (p === '/' && method === 'GET') {
      const rows = game.rows();
      const grid = rows.map((row, r) => `<div role="group" aria-label="Row ${r + 1}">${[...row].map((ch, c) => {
        const name = `Row ${r + 1}, column ${c + 1}: ${LABEL[ch] ?? ch}`;
        const face = ch === 'F' ? '⚑' : ch === '#' || ch === '.' ? '&nbsp;' : esc(ch);
        return `<button name="cell" value="${r},${c}" aria-label="${name}"${ch === '#' || ch === 'F' ? '' : ' disabled'}>${face}</button>`; }).join('')}</div>`).join('');
      const hidden = rows.join('').replace(/[^#F]/g, '').length;
      const status = game.status === 'won' ? 'You won!' : game.status === 'lost' ? 'You hit a mine. Game over.' : 'Playing';
      return { html: page(`Minesweeper board ${n}`, `<h1>Minesweeper: board ${n}</h1>
        <p role="status">Status: ${status} · Mines: ${MINES} · Flags: ${game.flags.size} · Hidden cells: ${hidden}</p>
        <form method="post" action="/act">
          <fieldset><legend>Click mode</legend>
            <label><input type="radio" name="mode" value="reveal" checked> Reveal</label>
            <label><input type="radio" name="mode" value="flag"> Flag</label></fieldset>
          <div style="font:16px monospace">${grid}</div></form>
        <h2>Board as text</h2><p>Rows top to bottom, columns left to right. # hidden, F flag, . empty, 1-8 mines touching, * mine.</p>
        <pre aria-label="Board as text">${rows.map((row, r) => `${String(r + 1).padStart(2)} ${row}`).join('\n')}</pre>`,
        '<style>button[name=cell]{width:30px;height:30px;margin:1px;font:bold 15px monospace;vertical-align:top}button[name=cell]:disabled{background:#eee;color:#225;border:1px solid #ccc}</style>') };
    }
    if (p === '/act' && method === 'POST') {
      const [r, c] = String(body.cell ?? '').split(',').map(Number);
      if (Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < SIZE && c < SIZE) {
        body.mode === 'flag' ? game.flag(r, c) : game.reveal(r, c);
      }
      return { redirect: '/' };
    }
    return null;
  };
}

const urls = Array.from({ length: BOARD_COUNT }, (_, i) => `board ${i + 1} at {url${i + 1}}`).join(', ');

// Partial credit for evals' autoresearch loop: board_N_progress once the player has opened more than half of the safe
// cells that were still hidden after the opening (the opening alone is often over half the board), then board_N_won.
// Does not change pass.
function milestones({ games }) {
  const progress = (g) => { const start = g.startOpen ?? 0; return (g.open?.size ?? 0) - start > (SIZE * SIZE - MINES - start) / 2; };
  return [
    ...games.map((g, i) => ({ name: `board_${i + 1}_progress`, ok: g.status === 'won' || progress(g) })),
    ...games.map((g, i) => ({ name: `board_${i + 1}_won`, ok: g.status === 'won' })),
  ];
}

// Pass or fail, all or nothing.
function judge({ games }) {
  const won = games.filter((g) => g.status === 'won').length;
  const lost = games.map((g, i) => (g.status === 'lost' ? i + 1 : null)).filter(Boolean);
  const detail = `${won}/${games.length} boards won` + (lost.length ? `, lost board ${lost.join(', ')}` : '')
    + `, ${games.reduce((s, g) => s + g.clicks, 0)} clicks`;
  return { pass: won === games.length, detail };
}

export default {
  id: 'minesweeper-swarm',
  goal: `Win ${BOARD_COUNT} games of Minesweeper that are open at the same time: ${urls}. `
    + `Each board is ${SIZE} by ${SIZE} with ${MINES} mines, and the opening area is already revealed. Every board can be solved by logic alone, with no guessing. `
    + 'Revealing a mine loses that board for good, so only reveal a cell when you are sure it is safe. '
    + `Spawn ${BOARD_COUNT} workers right away, one per board, so all boards are played at the same time. Give each worker only its own board's address; each worker plays only that board and reports when it is won or lost.`,
  servers: ['browser'],
  timeout: 900,
  maxSteps: 400,
  async setup(ctx) {
    ctx.boardSeeds = seedsFor(ctx.seed);
    ctx.games = ctx.boardSeeds.map((s) => { const g = newGame(layMines(s)); g.reveal(...START); g.clicks = 0; g.startOpen = g.open.size; return g; });
    ctx.sites = await Promise.all(ctx.games.map((g, i) => serve(app(g, i + 1))));
    ctx.sites.forEach((s, i) => { ctx[`url${i + 1}`] = s.url; });
  },
  check: (ctx) => ({ ...judge(ctx), milestones: milestones(ctx) }),
  teardown: ({ sites }) => Promise.all((sites ?? []).map((s) => s.close())),
  SEEDS, seedsFor, solveStep, newGame, layMines, START,
  // The stub plays each board with the same logic solver, reading the board text from the page.
  stub: Array.from({ length: BOARD_COUNT }, (_, i) => [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: ctx[`url${i + 1}`] } }),
    { name: 'browser__browser_evaluate', input: { function: `async () => {
      const solveStep = ${solveStep.toString()};
      for (let i = 0; i < 200; i++) {
        const html = await (await fetch('/')).text();
        if (/You won!|Game over/.test(html)) return html.match(/Status: [^·]+/)[0];
        const pre = html.match(/<pre[^>]*>([\\s\\S]*?)<\\/pre>/)[1];
        const rows = pre.split('\\n').map((l) => l.slice(3));
        const { safe, mines } = solveStep(rows);
        const act = (mode, [r, c]) => fetch('/act', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ mode, cell: r + ',' + c }) });
        for (const m of mines) if (rows[m[0]][m[1]] === '#') await act('flag', m);
        for (const s of safe) await act('reveal', s);
        if (!safe.length && !mines.length) return 'stuck';
      }
      return 'out of moves'; }` } },
  ]).flat(),
};
