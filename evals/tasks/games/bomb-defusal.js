// Game, co-op: "talk while someone defuses". Two local sites on two ports. The bomb site shows the bomb (serial
// number, batteries, indicator, four modules) but no rules; the manual site has the rules but cannot see the bomb.
// So one worker reads the manual while another works the bomb, and they talk through the board.
// Everything is in the accessibility tree: labelled buttons, a role="status" line, plain-text rules. No vision.
// Modules, defused in order: wires, button, keypad, word dial. A wrong move is a strike; 3 strikes or the
// 15-minute timer (server-side) and the bomb explodes.
// The default bomb comes from a fixed seed chosen so that the rules it needs depend on the bomb's edgework and sit
// next to a near miss (see DEFAULT_WANTS). With ctx.seed set, setup builds a variant from that seed instead.
// solve(bomb) applies the manual's rules; it is checked against every bomb used, and it drives the stub.
// Pass: defused. Milestones: one per module solved, plus no_strikes.
import { serve, page, esc } from '../../lib/site.mjs';

const MODULES = ['wires', 'button', 'keypad', 'word'];
const MODULE_TITLE = { wires: 'Wires', button: 'The button', keypad: 'Keypad', word: 'Word dial' };
const MAX_STRIKES = 3;
const TIME_LIMIT_MS = 15 * 60 * 1000;

const COLOURS = ['red', 'blue', 'yellow', 'white', 'black'];
const BUTTON_COLOURS = ['red', 'blue', 'white', 'yellow'];
const BUTTON_LABELS = ['Abort', 'Detonate', 'Hold', 'Press'];
const INDICATORS = ['CAR', 'FRK', 'BOB', 'SND', 'MSA', 'TRN'];
const SERIAL_CHARS = 'ABCDEFGHJKLMNPRSTUVWXZ0123456789';
// The manual's data. solve() gets these as arguments so its source can run in the browser on its own.
const COLUMNS = [
  ['omega', 'star', 'trident', 'lambda', 'kite', 'spiral', 'hook'],
  ['ghost', 'omega', 'hook', 'ladder', 'crown', 'star', 'eye'],
  ['anchor', 'moon', 'ladder', 'snake', 'kite', 'comet', 'ghost'],
  ['pumpkin', 'key', 'bell', 'comet', 'eye', 'flame', 'lambda'],
  ['tower', 'flame', 'bell', 'wave', 'diamond', 'moon', 'trident'],
];
const LISTS = {
  A: ['able', 'bark', 'coin', 'dusk', 'echo', 'fern', 'gift', 'harp', 'iris', 'jolt', 'knot', 'lamp'],
  B: ['mint', 'nest', 'oath', 'pike', 'quay', 'rust', 'salt', 'tide', 'urge', 'vast', 'wolf', 'yarn'],
};
const RELEASE = { blue: 4, white: 1, yellow: 5, red: 3 };
const MANUAL = { COLUMNS, LISTS, RELEASE };

// Apply the manual to a bomb. Returns the actions in order and the rule used for each module.
// bomb = { serial, batteries, indicator: { label, lit }, wires: [colour], button: { colour, label, strip? },
//          keypad: [symbol], dial: [[letter]] }. Without button.strip, the release digit is left undefined.
// Self-contained on purpose: the stub ships its source into the browser.
export function solve(bomb, { COLUMNS, LISTS, RELEASE }) {
  const lastDigit = Number(bomb.serial.match(/\d(?=\D*$)/)[0]);
  const odd = lastDigit % 2 === 1;
  const lit = bomb.indicator.lit;
  const ind = (label) => lit && bomb.indicator.label === label;
  const w = bomb.wires;
  const count = (c) => w.filter((x) => x === c).length;
  let wire, wiresRule;
  if (odd && count('red') > 1) { wire = w.lastIndexOf('red') + 1; wiresRule = 'W1'; }
  else if (w.length === 6 && count('yellow') === 0) { wire = 3; wiresRule = 'W2'; }
  else if (w.at(-1) === 'white' && lit) { wire = 1; wiresRule = 'W3'; }
  else if (count('blue') === 1) { wire = w.indexOf('blue') + 1; wiresRule = 'W4'; }
  else if (bomb.batteries > 2) { wire = w.length; wiresRule = 'W5'; }
  else { wire = 2; wiresRule = 'W6'; }

  const b = bomb.button;
  let press, buttonRule;
  if (b.colour === 'blue' && b.label === 'Abort') { press = 'hold'; buttonRule = 'B1'; }
  else if (bomb.batteries > 1 && b.label === 'Detonate') { press = 'press'; buttonRule = 'B2'; }
  else if (b.colour === 'white' && ind('CAR')) { press = 'hold'; buttonRule = 'B3'; }
  else if (bomb.batteries > 2 && ind('FRK')) { press = 'press'; buttonRule = 'B4'; }
  else if (b.colour === 'red' && b.label === 'Hold') { press = 'press'; buttonRule = 'B5'; }
  else { press = 'hold'; buttonRule = 'B6'; }
  const digit = press === 'hold' && b.strip ? RELEASE[b.strip] : undefined;

  const cols = COLUMNS.filter((col) => bomb.keypad.every((s) => col.includes(s)));
  if (cols.length !== 1) throw new Error(`${cols.length} keypad columns hold all four symbols`);
  const vowel = /[AEIOU]/.test(bomb.serial);
  let keys = cols[0].filter((s) => bomb.keypad.includes(s));
  if (vowel) keys = keys.reverse();

  const list = bomb.batteries % 2 === 0 ? 'A' : 'B';
  const spells = (word) => [...word].every((ch, i) => bomb.dial[i]?.includes(ch.toUpperCase()));
  const words = LISTS[list].filter(spells);
  if (words.length !== 1) throw new Error(`${words.length} words in list ${list} fit the dial`);

  return {
    actions: [
      { module: 'wires', wire },
      { module: 'button', press, ...(press === 'hold' ? { digit } : {}) },
      { module: 'keypad', keys },
      { module: 'word', word: words[0] },
    ],
    rules: { wires: wiresRule, button: buttonRule, keypad: vowel ? 'K-reverse' : 'K-forward', word: `list ${list}`,
      ...(digit !== undefined ? { release: `strip ${b.strip}` } : {}) },
  };
}

function rng(seed) {   // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// One random bomb from a seed, or null when the seed gives an ambiguous keypad or dial.
export function makeBomb(seed) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const serial = Array.from({ length: 5 }, () => pick(SERIAL_CHARS)).join('') + pick('0123456789');
  const batteries = 1 + Math.floor(rand() * 4);
  const indicator = { label: pick(INDICATORS), lit: rand() < 0.5 };
  const wires = Array.from({ length: 4 + Math.floor(rand() * 3) }, () => pick(COLOURS));
  const button = { colour: pick(BUTTON_COLOURS), label: pick(BUTTON_LABELS), strip: pick(Object.keys(RELEASE)) };
  const keypad = shuffle(shuffle(pick(COLUMNS)).slice(0, 4));
  if (COLUMNS.filter((col) => keypad.every((s) => col.includes(s))).length !== 1) return null;
  const wa = pick(LISTS.A), wb = pick(LISTS.B);
  const dial = [0, 1, 2, 3].map((i) => {
    const set = new Set([wa[i].toUpperCase(), wb[i].toUpperCase()]);
    while (set.size < 5) set.add(pick('ABCDEFGHIJKLMNOPRSTUVWY'));
    return [...set].sort();
  });
  const spells = (word) => [...word].every((ch, i) => dial[i].includes(ch.toUpperCase()));
  if (LISTS.A.filter(spells).length !== 1 || LISTS.B.filter(spells).length !== 1) return null;
  return { serial, batteries, indicator, wires, button, keypad, dial };
}

// A playable bomb for any seed: the first valid one at or after it (most seeds are valid at once).
export function bombFor(seed) {
  for (let k = 0; k < 1000; k++) { const b = makeBomb(seed * 1000 + k); if (b) return b; }
  throw new Error(`no valid bomb near seed ${seed}`);
}

// The default bomb: each module's answer comes from a rule that reads the edgework, with a near miss beside it.
//   wires   W1 (odd serial, two reds: cut the last red), while W4 (exactly one blue wire) would also match, and the
//           last red is not the last wire
//   button  B3 (white button, lit CAR: hold), so the strip and the release digit matter
//   keypad  the serial has a vowel, so the keys go bottom to top
//   word    the other list also has a word the dial can spell
const DEFAULT_WANTS = (b, s) => s.rules.wires === 'W1' && b.wires.filter((c) => c === 'blue').length === 1
  && b.wires.at(-1) !== 'red' && s.rules.button === 'B3' && s.rules.keypad === 'K-reverse';
let DEFAULT_SEED = null;
for (let s = 1; s < 200000 && DEFAULT_SEED === null; s++) {
  const b = makeBomb(s);
  if (b && DEFAULT_WANTS(b, solve(b, MANUAL))) DEFAULT_SEED = s;
}
if (DEFAULT_SEED === null) throw new Error('bomb-defusal: no seed exercises the intended rules');
const DEFAULT_BOMB = makeBomb(DEFAULT_SEED);

// Server-side game state. now() is injectable for tests.
export function newGame(bomb, { now = () => Date.now() } = {}) {
  const answer = solve(bomb, MANUAL);
  const want = Object.fromEntries(answer.actions.map((a) => [a.module, a]));
  const g = { bomb, answer, now, started: now(), solved: [], strikes: 0, status: 'armed', cause: null, endedAt: null,
    cut: new Set(), held: false, pressed: [], last: 'None yet.' };
  const end = (status, cause) => { g.status = status; g.cause = cause; g.endedAt = g.now(); };
  g.tick = () => { if (g.status === 'armed' && g.now() - g.started >= TIME_LIMIT_MS) end('exploded', 'time ran out'); };
  g.timeLeft = () => Math.max(0, TIME_LIMIT_MS - ((g.endedAt ?? g.now()) - g.started));
  g.current = () => MODULES[g.solved.length];
  const solved = (m, msg) => { g.solved.push(m); g.last = `${msg} The ${MODULE_TITLE[m].toLowerCase()} module is defused.`;
    if (g.solved.length === MODULES.length) { end('defused', null); g.last += ' The bomb is defused!'; } };
  const strike = (msg) => { g.strikes++; g.last = `${msg} Strike ${g.strikes}!`;
    if (g.strikes >= MAX_STRIKES) { end('exploded', `${MAX_STRIKES} strikes`); g.last += ' The bomb exploded.'; } };
  const ready = (m) => {
    g.tick();
    if (g.status !== 'armed') { g.last = `The bomb is already ${g.status}.`; return false; }
    if (g.current() !== m) { g.last = `The ${MODULE_TITLE[m].toLowerCase()} module is ${g.solved.includes(m) ? 'already defused' : `locked: defuse the ${MODULE_TITLE[g.current()].toLowerCase()} first`}.`; return false; }
    return true;
  };
  g.cutWire = (n) => {
    if (!ready('wires') || !(n >= 1 && n <= bomb.wires.length) || g.cut.has(n)) return;
    g.cut.add(n);
    const what = `You cut the ${ord(n)} wire (${bomb.wires[n - 1]}).`;
    n === want.wires.wire ? solved('wires', what) : strike(`${what} Wrong wire.`);
  };
  g.pressButton = (how) => {
    if (!ready('button')) return;
    if (how === 'hold' && g.held) return;
    if (how !== want.button.press) return strike(how === 'hold' ? 'You held the button. It should have been pressed and released at once.' : 'You pressed and released the button. It should have been held.');
    if (how === 'press') return solved('button', 'You pressed and released the button.');
    g.held = true;
    g.last = `You are holding the button. A strip beside it lights up ${bomb.button.strip}.`;
  };
  g.release = (d) => {
    if (!ready('button') || !g.held) return;
    g.held = false;
    d === want.button.digit ? solved('button', `You released the button on a ${d}.`) : strike(`You released the button on a ${d}. Wrong digit, and the button let go.`);
  };
  g.pressKey = (sym) => {
    if (!ready('keypad') || !bomb.keypad.includes(sym) || g.pressed.includes(sym)) return;
    const next = want.keypad.keys[g.pressed.length];
    if (sym !== next) return strike(`You pressed ${sym}. Wrong key.`);
    g.pressed.push(sym);
    g.pressed.length === 4 ? solved('keypad', `You pressed ${sym}.`) : (g.last = `You pressed ${sym}. Correct, keep going.`);
  };
  g.submitWord = (raw) => {
    if (!ready('word')) return;
    const word = String(raw ?? '').trim().toLowerCase();
    const fits = /^[a-z]{4}$/.test(word) && [...word].every((ch, i) => bomb.dial[i].includes(ch.toUpperCase()));
    if (!fits) { g.last = `The dial cannot spell "${word}". Nothing happened.`; return; }
    word === want.word.word ? solved('word', `You set the dial to ${word.toUpperCase()}.`) : strike(`You set the dial to ${word.toUpperCase()}. Wrong word.`);
  };
  return g;
}

const ord = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;
const mmss = (ms) => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function bombPage(g) {
  g.tick();
  const { bomb } = g;
  const state = g.status === 'defused' ? 'Bomb defused!' : g.status === 'exploded' ? `BOOM: the bomb exploded (${g.cause}).` : 'Bomb armed';
  const left = MODULES.length - g.solved.length;
  const section = (m, i, body) => {
    const tag = g.solved.includes(m) ? 'defused' : g.status === 'armed' && g.current() === m ? 'active' : 'locked';
    return `<h2>Module ${i + 1}: ${MODULE_TITLE[m]} (${tag})</h2>${tag === 'defused' ? '<p>Defused.</p>' : body(tag === 'active')}`;
  };
  const form = (action, inner) => `<form method="post" action="${action}">${inner}</form>`;
  const wires = (on) => `<p>${bomb.wires.length} wires, top to bottom: ${bomb.wires.join(', ')}.</p>`
    + (on ? form('/wires', bomb.wires.map((c, i) => g.cut.has(i + 1) ? '' : `<button name="wire" value="${i + 1}">Cut the ${ord(i + 1)} wire (${c})</button> `).join('')) : '')
    + (g.cut.size ? `<p>Already cut: ${[...g.cut].map((n) => `${ord(n)} wire`).join(', ')}.</p>` : '');
  const button = (on) => `<p>A ${bomb.button.colour} button labelled "${esc(bomb.button.label)}".</p>`
    + (on && !g.held ? form('/button', '<button name="how" value="press">Press and release the button</button> <button name="how" value="hold">Press and hold the button</button>') : '')
    + (on && g.held ? `<p>You are holding the button. A strip beside it is lit ${bomb.button.strip}.</p>`
      + form('/release', Array.from({ length: 10 }, (_, d) => `<button name="digit" value="${d}">Release on digit ${d}</button>`).join(' ')) : '');
  const keypad = (on) => `<p>Four keys, left to right: ${bomb.keypad.join(', ')}.</p>`
    + (g.pressed.length ? `<p>Pressed so far: ${g.pressed.join(', ')}.</p>` : '')
    + (on ? form('/keypad', bomb.keypad.filter((s) => !g.pressed.includes(s)).map((s) => `<button name="symbol" value="${s}">Press the ${s} key</button>`).join(' ')) : '');
  const word = (on) => `<p>The dial spells a 4-letter word. The letters each position can show:</p><ul>${bomb.dial.map((ls, i) => `<li>Position ${i + 1}: ${ls.join(', ')}</li>`).join('')}</ul>`
    + (on ? form('/word', '<label for="word">Word</label> <input id="word" name="word" autocomplete="off"> <button>Submit word</button>') : '');
  const bodies = { wires, button, keypad, word };
  return page('Bomb', `<h1>Bomb</h1>
    <p role="status">${state} · Modules left: ${left} of ${MODULES.length} · Strikes: ${g.strikes} of ${MAX_STRIKES} · Time left: ${mmss(g.timeLeft())}</p>
    <p>Last action: ${esc(g.last)}</p>
    <h2>Outside of the bomb</h2>
    <ul><li>Serial number: ${bomb.serial}</li><li>Batteries: ${bomb.batteries}</li><li>Indicator: ${bomb.indicator.label}, ${bomb.indicator.lit ? 'lit' : 'unlit'}</li></ul>
    <p>Defuse the modules in order. A wrong move is a strike. ${MAX_STRIKES} strikes, or the timer reaching 0:00, and the bomb explodes.</p>
    ${MODULES.map((m, i) => section(m, i, bodies[m])).join('\n')}`);
}

const MANUAL_HTML = page('Bomb defusal manual', `<h1>Bomb defusal manual</h1>
<p>This manual cannot see the bomb. Ask the person at the bomb for the facts each rule needs. Defuse the modules in this order: wires, the button, keypad, word dial. In each list of rules, use the first rule that applies.</p>
<h2>Facts on the outside of the bomb</h2>
<ul><li>The serial number: its last digit, and whether it contains a vowel (A, E, I, O or U).</li>
<li>The number of batteries.</li><li>The indicator: its three-letter label, and whether it is lit.</li></ul>
<h2>Module 1: Wires</h2>
<p>Count wires from the top: the top wire is the 1st. Cut exactly one wire.</p>
<ol><li>If the last digit of the serial number is odd and there is more than one red wire: cut the last red wire.</li>
<li>Otherwise, if there are exactly 6 wires and no yellow wire: cut the 3rd wire.</li>
<li>Otherwise, if the last (bottom) wire is white and the indicator is lit: cut the 1st wire.</li>
<li>Otherwise, if there is exactly one blue wire: cut the blue wire.</li>
<li>Otherwise, if the bomb has more than 2 batteries: cut the last wire.</li>
<li>Otherwise: cut the 2nd wire.</li></ol>
<h2>Module 2: The button</h2>
<ol><li>If the button is blue and says "Abort": hold it.</li>
<li>Otherwise, if the bomb has more than 1 battery and the button says "Detonate": press and release it at once.</li>
<li>Otherwise, if the button is white and the indicator is CAR and lit: hold it.</li>
<li>Otherwise, if the bomb has more than 2 batteries and the indicator is FRK and lit: press and release it at once.</li>
<li>Otherwise, if the button is red and says "Hold": press and release it at once.</li>
<li>Otherwise: hold it.</li></ol>
<p>When you hold the button, a strip beside it lights up. Release the button on this digit:</p>
<ul>${Object.entries(RELEASE).map(([c, d]) => `<li>${c} strip: release on ${d}</li>`).join('')}</ul>
<h2>Module 3: Keypad</h2>
<p>The keypad has four keys, each with a symbol. Exactly one of these columns contains all four symbols:</p>
<ul>${COLUMNS.map((col, i) => `<li>Column ${i + 1}, top to bottom: ${col.join(', ')}</li>`).join('')}</ul>
<p>Press the four keys in the order they appear in that column, top to bottom. Exception: if the serial number contains a vowel, press them bottom to top instead.</p>
<h2>Module 4: Word dial</h2>
<p>If the number of batteries is even, the word is in list A. If it is odd, the word is in list B. Exactly one word in that list can be spelled with the letters the dial shows in each position. Set the dial to it and submit.</p>
<ul><li>List A: ${LISTS.A.join(', ')}</li><li>List B: ${LISTS.B.join(', ')}</li></ul>`);

function bombApp(g) {
  return async ({ method, path: p, body }) => {
    if (p === '/' && method === 'GET') return { html: bombPage(g) };
    if (method !== 'POST') return null;
    if (p === '/wires') g.cutWire(Number(body.wire));
    else if (p === '/button') g.pressButton(body.how);
    else if (p === '/release') g.release(Number(body.digit));
    else if (p === '/keypad') g.pressKey(String(body.symbol ?? ''));
    else if (p === '/word') g.submitWord(body.word);
    else return null;
    return { redirect: '/' };
  };
}

// Read the bomb back from the page's text, as a text-only agent would. Self-contained: the stub runs it in the browser.
export function readBomb(text) {
  const m = (re) => text.match(re);
  const ind = m(/Indicator: (\w+), (lit|unlit)/);
  const btn = m(/A (\w+) button labelled "(\w+)"/);
  const strip = m(/strip beside it is lit (\w+)/);
  return {
    serial: m(/Serial number: (\w+)/)[1],
    batteries: Number(m(/Batteries: (\d+)/)[1]),
    indicator: { label: ind[1], lit: ind[2] === 'lit' },
    wires: m(/wires, top to bottom: ([^.]+)\./)?.[1].split(', ') ?? [],
    button: btn ? { colour: btn[1], label: btn[2], ...(strip ? { strip: strip[1] } : {}) } : { colour: '', label: '' },
    keypad: m(/Four keys, left to right: ([^.]+)\./)?.[1].split(', ') ?? [],
    dial: [...text.matchAll(/Position \d: ([A-Z, ]+)/g)].map((x) => x[1].split(', ')),
  };
}

export default {
  id: 'bomb-defusal',
  goal: 'Co-op bomb defusal. A bomb is armed at {bombUrl}, and its defusal manual is at {manualUrl}. '
    + 'The bomb page shows the bomb but none of the rules; the manual has the rules but cannot see the bomb. '
    + 'Use two workers: one reads the manual, the other works the bomb, and they talk through the board. '
    + 'The bomb worker reports what the manual worker asks for (the serial number, batteries, indicator and each module), '
    + 'the manual worker works out the move from the rules, and the bomb worker makes it. '
    + `Defuse its ${MODULES.length} modules in order. A wrong move is a strike; ${MAX_STRIKES} strikes, or the 15-minute timer running out, and the bomb explodes. `
    + 'Never guess: work each move out from the manual first.',
  servers: ['browser'],
  timeout: 1200,
  maxSteps: 300,
  async setup(ctx) {
    const bomb = Number.isFinite(ctx.seed) ? bombFor(ctx.seed) : DEFAULT_BOMB;
    ctx.game = newGame(bomb);   // newGame runs solve(), which throws if the bomb has no unique answer
    const [bombSite, manualSite] = await Promise.all([serve(bombApp(ctx.game)), serve(async ({ method, path: p }) => (method === 'GET' && p === '/' ? { html: MANUAL_HTML } : null))]);
    ctx.sites = [bombSite, manualSite];
    ctx.bombUrl = bombSite.url;
    ctx.manualUrl = manualSite.url;
  },
  check({ game: g }) {
    g.tick();
    const used = mmss((g.endedAt ?? g.now()) - g.started);
    const state = g.status === 'defused' ? 'defused' : g.status === 'exploded' ? `exploded (${g.cause})` : 'not defused';
    const detail = `${state}: ${g.solved.length}/${MODULES.length} modules solved${g.solved.length ? ` (${g.solved.join(', ')})` : ''}, `
      + `${g.strikes} strike${g.strikes === 1 ? '' : 's'}, ${used} used`;
    const milestones = [...MODULES.map((m) => ({ name: m, ok: g.solved.includes(m) })),
      { name: 'no_strikes', ok: g.solved.length > 0 && g.strikes === 0 }];
    return { pass: g.status === 'defused', detail, milestones };
  },
  teardown: ({ sites }) => Promise.all((sites ?? []).map((s) => s.close())),
  MODULES, MANUAL, DEFAULT_SEED, DEFAULT_BOMB, TIME_LIMIT_MS, solve, makeBomb, bombFor, newGame, readBomb,
  // One worker plays both roles: read the manual, then read the bomb's text, apply the rules and click by accessible name.
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: ctx.manualUrl } }),
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: ctx.bombUrl } }),
    { name: 'browser__browser_run_code_unsafe', input: { code: `async (page) => {
      const MANUAL = ${JSON.stringify(MANUAL)};
      const solve = ${solve.toString()};
      const readBomb = ${readBomb.toString()};
      const look = async () => readBomb(await page.locator('body').innerText());
      const click = (name) => page.getByRole('button', { name, exact: true }).click();
      const ord = (n) => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
      let bomb = await look();
      const [wires, button, keypad, word] = solve(bomb, MANUAL).actions;
      await click('Cut the ' + ord(wires.wire) + ' wire (' + bomb.wires[wires.wire - 1] + ')');
      if (button.press === 'press') await click('Press and release the button');
      else {
        await click('Press and hold the button');
        const digit = solve(await look(), MANUAL).actions[1].digit;
        await click('Release on digit ' + digit);
      }
      for (const k of keypad.keys) await click('Press the ' + k + ' key');
      await page.getByLabel('Word').fill(word.word);
      await click('Submit word');
      return await page.getByRole('status').innerText(); }` } },
  ],
};
