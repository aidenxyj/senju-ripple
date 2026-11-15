// check(agent, action) -> { allow: true } | { deny: true, reason } | { confirm: true, card }
//
// Runs before every action. Two rules are enforced in code, whatever the model says:
//   1. Sending a message or email, paying, or deleting needs a person's click first (confirm).
//   2. A loop is denied: when the same action has just produced the same result three times in a row,
//      a fourth try is refused with a reason that tells the model to do something else.
// Rule 2 needs results, so whoever runs the action reports it back with record(agent, action, result).
//
// An action can be any of:
//   "senju click e12"                                   one shell line
//   { verb: 'click', args: ['e12'], element: { role, name } }   a parsed senju command; element is what eyes/ says e12 is
//       shell/ adds page hints to element when the name cannot tell: { hints, field, drafted, deleteNear, where }
//       (an icon-only button, type --submit, Enter). See unnamedKind and submitKind below.
//   { name: 'browser__browser_click', input: { ... } }  a plain tool call (the function-calling path)
//   { name: 'sh', input: { cmd: '...' } }               several senju lines: the strictest verdict wins

// What a button or link says when clicking it sends something ("Reply" and "Messages" only open a view, so they are not here).
const SEND_CLICK = /\b(send|post|tweet|publish)\b/i;
// What a tool's name says when calling it sends something (read_messages and list_emails are filtered out before this).
const SEND_TOOL = /\b(send|post|reply|forward|tweet|publish|comment|message|email|mail|dm)\b/i;
const PAY = /\b(pay|payment|payments|purchase|buy|checkout|check out|place (?:your )?order|order now|complete (?:the )?order|submit order|donate|transfer|wire|subscribe now|upgrade now)\b/i;
const DELETE = /\b(delete|deleted|remove|trash|discard|erase|destroy|wipe|purge|unlink|rmdir|empty trash|uninstall)\b/i;
const SHELL_DELETE = /(^|[\s;&|(])(rm|rmdir|unlink|shred|trash|srm)\s|\bgit\s+(clean|reset\s+--hard|push\s+.*--force)|\bdrop\s+(table|database)\b|\bdelete\s+from\b/i;
const SHELL_SEND = /(^|[\s;&|(])(mail|sendmail|mutt|msmtp)\s|\bosascript\b.*\bsend\b/i;

// Icon names and classes on an unnamed button ("icon-send", "PaperPlane", "trash-can", "bin").
const SEND_ICON = /\b(send|submit|post|tweet|publish|paper ?plane)\b/i;
const DELETE_ICON = /\b(bin|garbage|trashcan)\b/i;
// A text field whose label says it is for a message, and pages that are about messages.
const MESSAGE_FIELD = /\b(message|messages|reply|comment|chat|compose|tweet|post|dm|email|mail|body|write (?:a|your|something)|say something|what'?s happening|what'?s on your mind)\b/i;
const MESSAGE_PAGE = /\b(messages?|messenger|messaging|chat|inbox|mail|compose|dm|dms|conversation|direct)\b/i;
const SEARCH_FIELD = /\b(search|query|find|filter)\b/i;

// Keyboard shortcuts that send or delete in common Mac apps.
const KEY_SEND = new Set(['cmd+enter', 'cmd+return', 'cmd+shift+d', 'ctrl+enter']);
const KEY_DELETE = new Set(['cmd+backspace', 'cmd+delete', 'cmd+shift+backspace', 'cmd+shift+delete', 'cmd+alt+backspace']);

// senju verbs that only read or coordinate. They are never confirmed (a board post is a note to the other workers).
const SAFE_VERBS = new Set(['look', 'board', 'wait', 'ask', 'done', 'open', 'search', 'find']);

export function createGuard({ loopLimit = 3 } = {}) {
  const history = new Map();   // agent key -> [{ key, result }], newest last
  const agentKey = (agent) => String(agent?.id ?? agent?.name ?? agent ?? 'agent');
  const agentName = (agent) => String(agent?.name ?? agent?.id ?? agent ?? 'An agent');

  function checkOne(agent, act) {
    const past = history.get(agentKey(agent)) ?? [];
    const recent = past.slice(-loopLimit);
    if (recent.length === loopLimit && recent.every((r) => r.key === act.key && r.result === recent[0].result)) {
      return {
        deny: true,
        reason: `Loop: you ran "${act.text}" ${loopLimit} times in a row and got the same result each time, so it was not run again. ` +
          'Try something different: look at the screen again, pick another element or approach, or report what is blocking you.',
      };
    }
    const kind = classify(act);
    if (kind) return { confirm: true, card: card(kind, agentName(agent), act) };
    return { allow: true };
  }

  return {
    check(agent, action) {
      const acts = normalize(action);
      if (acts.length === 0) return { allow: true };
      let confirm = null;
      for (const act of acts) {
        const v = checkOne(agent, act);
        if (v.deny) return v;
        if (v.confirm && !confirm) confirm = v;
      }
      return confirm ?? { allow: true };
    },
    record(agent, action, result) {
      const key = agentKey(agent);
      const list = history.get(key) ?? [];
      for (const act of normalize(action)) list.push({ key: act.key, result: normalizeResult(result) });
      if (list.length > 50) list.splice(0, list.length - 50);
      history.set(key, list);
    },
    reset(agent) {
      if (agent === undefined) history.clear(); else history.delete(agentKey(agent));
    },
  };
}

// ---- Normalising actions -------------------------------------------------------------------------

// -> [{ key, text, verb, args, toolName, input, element }]
export function normalize(action) {
  if (action == null) return [];
  if (typeof action === 'string') return action.split('\n').map((l) => l.trim()).filter(Boolean).map(fromLine);
  if (typeof action !== 'object') return [];
  if (action.verb) return [fromParsed(action)];
  if ((action.name === 'sh' || String(action.name).endsWith('__sh')) && typeof action.input?.cmd === 'string') return normalize(action.input.cmd);
  if (action.name) {
    const input = action.input ?? {};
    return [{ key: `tool:${action.name}:${stable(input)}`, text: `${action.name} ${stable(input)}`, toolName: action.name, input, element: action.element ?? null }];
  }
  return [];
}

function fromLine(line) {
  const words = splitWords(line);
  if (words[0] === 'senju') words.shift();
  const [verb = '', ...args] = words;
  if (!verb) return { key: `line:${line}`, text: line, verb: '', args: [], raw: line };
  return fromParsed({ verb, args, raw: line });
}

function fromParsed({ verb, args = [], flags = {}, element = null, raw = null }) {
  const v = String(verb).toLowerCase();
  const a = args.map(String);
  const f = Object.keys(flags ?? {}).filter((k) => flags[k]).map((k) => `--${k}`);
  const all = [...a, ...f];
  return { key: `senju:${v}:${JSON.stringify(all)}`, text: raw ?? `senju ${[v, ...all.map(quoteIfNeeded)].join(' ')}`, verb: v, args: a, flags: { ...flags }, element, raw };
}

function splitWords(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]);
  return out;
}

const quoteIfNeeded = (s) => (/\s/.test(s) ? JSON.stringify(s) : s);

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function normalizeResult(result) {
  if (result == null) return '';
  const text = typeof result === 'string' ? result
    : Array.isArray(result) ? result.map((b) => b?.text ?? '').join('\n')
    : result.text ?? result.content ?? JSON.stringify(result);
  return String(typeof text === 'string' ? text : JSON.stringify(text)).replace(/\s+/g, ' ').trim();
}

// ---- Classifying ---------------------------------------------------------------------------------

// -> 'send' | 'pay' | 'delete' | null
export function classify(act) {
  const elementText = act.element?.name ?? '';

  if (act.verb !== undefined && act.toolName === undefined) {
    const verb = act.verb;
    if (SAFE_VERBS.has(verb)) return null;
    if (verb === 'key') {
      const combo = normCombo(act.args[0] ?? '');
      if (KEY_SEND.has(combo)) return 'send';
      if (KEY_DELETE.has(combo)) return 'delete';
      if ((combo === 'enter' || combo === 'return') && act.element) return submitKind(act.element);   // element: the focused one
      return null;
    }
    if (verb === 'click') return wordsKind(elementText, SEND_CLICK) ?? unnamedKind(act.element);
    if (verb === 'type') {
      // Typing alone sends nothing; typing with --submit presses Enter, which sends in a message box.
      const submit = act.flags?.submit || act.args.includes('--submit');
      return submit ? submitKind(act.element) : null;
    }
    // Unknown or new verbs: judge by the verb itself and its arguments.
    return wordsKind(`${verb} ${elementText}`, SEND_TOOL) ?? shellKind(act.args.join(' '));
  }

  // Plain tool calls: the tool name says what it does; the element description or target says what it acts on.
  const name = String(act.toolName ?? '').replace(/^[^_]+__/, '').replace(/_/g, ' ');
  const input = act.input ?? {};
  if (/\b(read|list|get|search|find|snapshot|screenshot|navigate|wait|hover|tabs|console|network|resize)\b/i.test(name) && !/\b(send|delete|remove|pay)\b/i.test(name)) return null;
  const byName = toolNameKind(name);
  if (byName) return byName;
  if (/\bpress key\b/i.test(name)) {
    const combo = normCombo(String(input.key ?? ''));
    if (KEY_SEND.has(combo)) return 'send';
    if (KEY_DELETE.has(combo)) return 'delete';
  }
  if (/\bclick\b/i.test(name)) return wordsKind([input.element, act.element?.name].filter(Boolean).join(' '), SEND_CLICK);
  for (const field of ['command', 'cmd', 'script']) if (typeof input[field] === 'string') { const k = shellKind(input[field]); if (k) return k; }
  return null;
}

// An element whose name says nothing (empty, or an arrow or emoji). Only judged when shell/ sent page hints.
// Reads aria-label, title and icon names first; then fails closed: in a composer with text typed it is a send,
// next to delete/trash/remove it is a delete.
export function unnamedKind(element) {
  if (!element || element.hints === undefined || !unnamed(element.name)) return null;
  const hints = words(element.hints);
  const byHints = wordsKind(hints, SEND_ICON) ?? (DELETE_ICON.test(hints) ? 'delete' : null);
  if (byHints) return byHints;
  if (element.drafted) return 'send';
  if (element.deleteNear) return 'delete';
  return null;
}

// Pressing Enter in a field (type --submit, or key enter on the focused element): a send when the field is
// for a message, a multiline box, or any field on a messages page. Search boxes never.
export function submitKind(element) {
  if (!element) return null;
  const f = element.field ?? null;
  const label = words([element.name, f?.label, f ? '' : element.hints].filter(Boolean).join(' '));
  if (f?.search || SEARCH_FIELD.test(label) || element.role === 'searchbox') return null;
  if (MESSAGE_FIELD.test(label)) return 'send';
  if (!f) return element.hints === undefined ? null : wordsKind(words(element.hints), SEND_CLICK) ?? unnamedKind(element);
  if (f.multiline) return 'send';
  if (element.where && MESSAGE_PAGE.test(words(element.where))) return 'send';
  return null;
}

const unnamed = (name) => !/[\p{L}\p{N}]/u.test(String(name ?? ''));
// "icon-trashCan" -> "icon trash Can", so word patterns see the parts.
const words = (s) => String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.:/#?=&]+/g, ' ');

function toolNameKind(name) {
  if (/\b(write|edit|create|move|type|fill|select|upload|drag|drop file|evaluate|run code)\b/i.test(name) && !/\b(send|delete|remove|trash|pay|purchase|post message)\b/i.test(name)) return null;
  return wordsKind(name, SEND_TOOL);
}

function wordsKind(text, send) {
  if (!text) return null;
  if (PAY.test(text)) return 'pay';
  if (DELETE.test(text)) return 'delete';
  if (send.test(text)) return 'send';
  return null;
}

function shellKind(cmd) {
  if (!cmd) return null;
  if (SHELL_DELETE.test(cmd)) return 'delete';
  if (SHELL_SEND.test(cmd)) return 'send';
  return null;
}

function normCombo(combo) {
  return combo.toLowerCase().replace(/\s+/g, '')
    .replace(/command|meta|⌘/g, 'cmd').replace(/control/g, 'ctrl').replace(/option|⌥/g, 'alt')
    .split('+').map((k) => (k === 'opt' ? 'alt' : k)).sort((x, y) => order(x) - order(y)).join('+');
}
const order = (k) => ({ cmd: 0, ctrl: 1, alt: 2, shift: 3 })[k] ?? 9;

const TITLES = { send: 'send a message', pay: 'make a payment', delete: 'delete something' };

function card(kind, who, act) {
  const el = act.element;
  const hint = el?.hints ? String(el.hints).slice(0, 60) : el?.field?.label ? String(el.field.label).slice(0, 60) : '';
  const target = el?.name && !unnamed(el.name) ? ` on "${el.name}"`
    : hint ? ` on an unnamed ${el?.role || 'element'} (${hint})${el?.drafted ? ' in a message box with text typed' : el?.deleteNear ? ' next to delete' : ''}`
    : act.input?.element ? ` on "${act.input.element}"` : '';
  return {
    kind,
    title: `${who} wants to ${TITLES[kind]}`,
    detail: `${act.text}${target}`,
    agent: who,
    action: act.text,
  };
}
