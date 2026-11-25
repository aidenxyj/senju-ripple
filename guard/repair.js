// repair(call, schema) -> { call } | { error }
//
// OpenAI-style endpoints send tool arguments as a JSON string (docs/model-notes.md). When adapter/ cannot parse that string,
// it passes the call on as { name, input: { _raw: "<the string>" } }. repair turns it back into a valid call:
// it fixes the usual JSON slips, then checks the result against the tool's input_schema and coerces what is
// safe to coerce ("3" -> 3 for a number, "true" -> true for a boolean). The error text is written for the
// model to read, so it says what the arguments should look like.

export function repair(call, schema) {
  const name = call?.name ?? 'tool';
  let input = call?.input;

  if (input && typeof input === 'object' && !Array.isArray(input) && typeof input._raw === 'string' && Object.keys(input).length === 1) {
    const parsed = input._raw.trim() === '' ? { ok: true, value: {} } : parseLoose(input._raw);
    if (parsed.ok) input = parsed.value;
    else {
      // Not JSON at all. A tool with one required string argument (sh { cmd }) almost certainly got that argument bare.
      const only = soleStringKey(schema);
      if (only && input._raw.trim()) input = { [only]: unwrapBare(input._raw) };
      else return { error: `The arguments for ${name} are not valid JSON (${parsed.why}). Send a JSON object like ${example(schema)}.` };
    }
  }
  if (typeof input === 'string') {
    const parsed = parseLoose(input);
    const only = soleStringKey(schema);
    if (parsed.ok && isObject(parsed.value)) input = parsed.value;
    else if (only) input = { [only]: input };
  }
  if (input == null) input = {};

  const checked = conform(input, schema);
  if (checked.error) return { error: `Invalid arguments for ${name}: ${checked.error}. Send a JSON object like ${example(schema)}.` };
  return { call: { ...call, input: checked.value } };
}

// ---- Loose JSON --------------------------------------------------------------------------------

export function parseLoose(text) {
  if (typeof text !== 'string') return { ok: false, why: 'not a string' };
  const attempts = [];
  let s = text.trim();
  attempts.push(s);
  s = s.replace(/^```(?:json|javascript|js)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();   // code fences
  attempts.push(s);
  const start = s.search(/[{[]/);
  if (start > 0) { s = s.slice(start); attempts.push(s); }                                    // prose before the object
  let fixed = singleToDouble(s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));   // smart and single quotes
  fixed = outsideStrings(fixed, (code) => code
    .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')      // Python literals
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/g, '$1"$2"$3')                                   // unquoted keys
    .replace(/,\s*([}\]])/g, '$1'));                                                              // trailing commas
  attempts.push(fixed);
  attempts.push(closeOpen(fixed));                                                             // missing closers
  attempts.push(cutAtBalance(fixed));                                                          // junk after the object
  let lastErr = 'empty';
  for (const a of attempts) {
    if (!a) continue;
    try { return { ok: true, value: JSON.parse(a) }; } catch (err) { lastErr = err.message; }
  }
  return { ok: false, why: lastErr };
}

// Turn 'single-quoted' JSON strings into "double-quoted" ones, leaving apostrophes inside double-quoted strings alone.
function singleToDouble(s) {
  let out = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && i + 1 < s.length) {
        const n = s[i + 1];
        if (quote === "'" && n === "'") { out += "'"; i++; continue; }
        out += c + n; i++; continue;
      }
      if (c === quote) { out += '"'; quote = null; continue; }
      if (quote === "'" && c === '"') { out += '\\"'; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      out += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += '"'; continue; }
    out += c;
  }
  if (quote) out += '"';   // unterminated string: close it so closeOpen can finish the object
  return out;
}

// Apply fn to the parts of s that are outside double-quoted strings.
function outsideStrings(s, fn) {
  let out = '';
  let code = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"') { code += s[i]; continue; }
    out += fn(code);
    code = '';
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    out += s.slice(i, j + 1);
    i = j;
  }
  return out + fn(code);
}

// Append the closing brackets an object is missing, ignoring brackets inside strings.
function closeOpen(s) {
  const stack = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
  }
  return (inStr ? s + '"' : s).replace(/,\s*$/, '') + stack.reverse().join('');
}

// Keep only the first complete object or array (drops trailing prose or a second object).
function cutAtBalance(s) {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return s.slice(0, i + 1);
  }
  return s;
}

// A bare argument such as `cmd: senju look` or `"senju look"`: strip a leading key and surrounding quotes.
function unwrapBare(raw) {
  let s = raw.trim().replace(/^```\w*\s*\n?/, '').replace(/\n?```$/, '').trim();
  s = s.replace(/^[{\s]*"?[A-Za-z_]\w*"?\s*[:=]\s*/, '').replace(/\s*}\s*$/, '');
  if (/^(["'`]).*\1$/s.test(s)) s = s.slice(1, -1);
  return s;
}

// ---- Schema ------------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function soleStringKey(schema) {
  const props = Object.entries(schema?.properties ?? {});
  const required = schema?.required ?? [];
  const strings = props.filter(([, p]) => [].concat(p?.type ?? []).includes('string'));
  if (required.length === 1 && strings.some(([k]) => k === required[0])) return required[0];
  if (props.length === 1 && strings.length === 1) return strings[0][0];
  return null;
}

// Check a value against a JSON schema (the subset tools use) and coerce safe mismatches. -> { value } | { error }
export function conform(value, schema, where = 'arguments') {
  if (!schema || typeof schema !== 'object') return { value };
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    const hit = typeof value === 'string' && schema.enum.find((e) => typeof e === 'string' && e.toLowerCase() === value.trim().toLowerCase());
    if (hit === undefined || hit === false) return { error: `${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` };
    value = hit;
  }
  const types = [].concat(schema.type ?? []);
  if (types.length === 0) return { value };
  if (types.some((t) => matches(value, t))) {
    if (isObject(value) && types.includes('object')) return conformObject(value, schema, where);
    if (Array.isArray(value) && types.includes('array') && schema.items) return conformArray(value, schema, where);
    return { value };
  }
  for (const t of types) {
    const c = coerce(value, t);
    if (c !== undefined) return conform(c, schema, where);
  }
  return { error: `${where} should be ${types.join(' or ')}, got ${describe(value)}` };
}

function conformObject(obj, schema, where) {
  const props = schema.properties ?? {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (props[k]) {
      if (v === null && !acceptsNull(props[k]) && !(schema.required ?? []).includes(k)) continue;   // null for an optional key: drop it
      const r = conform(v, props[k], where === 'arguments' ? `"${k}"` : `${where}.${k}`);
      if (r.error) return r;
      out[k] = r.value;
    } else if (schema.additionalProperties !== false) {
      out[k] = v;
    }
  }
  const missing = (schema.required ?? []).filter((k) => !(k in out));
  if (missing.length) return { error: `missing ${missing.map((k) => `"${k}"`).join(', ')}${where === 'arguments' ? '' : ` in ${where}`}` };
  return { value: out };
}

function conformArray(arr, schema, where) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const r = conform(arr[i], schema.items, `${where}[${i}]`);
    if (r.error) return r;
    out.push(r.value);
  }
  return { value: out };
}

const acceptsNull = (s) => [].concat(s?.type ?? []).includes('null');

function matches(v, t) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return isObject(v);
    case 'null': return v === null;
    default: return true;
  }
}

function coerce(v, t) {
  switch (t) {
    case 'number': {
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return undefined;
    }
    case 'integer': {
      if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v);
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1e-9) return Math.round(v);
      return undefined;
    }
    case 'boolean': {
      if (v === 'true' || v === 'True') return true;
      if (v === 'false' || v === 'False') return false;
      return undefined;
    }
    case 'string': {
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return undefined;
    }
    case 'array': {
      if (typeof v === 'string') { const p = parseLoose(v); if (p.ok && Array.isArray(p.value)) return p.value; }
      if (v !== undefined && v !== null && !Array.isArray(v)) return [v];
      return undefined;
    }
    case 'object': {
      if (typeof v === 'string') { const p = parseLoose(v); if (p.ok && isObject(p.value)) return p.value; }
      return undefined;
    }
    default: return undefined;
  }
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `the string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v)}`;
  return `a ${typeof v}`;
}

// A short example object for error messages, built from the schema.
export function example(schema) {
  const props = schema?.properties ?? {};
  const keys = (schema?.required?.length ? schema.required : Object.keys(props)).slice(0, 4);
  const sample = (p) => {
    const t = [].concat(p?.type ?? ['string'])[0];
    if (p?.enum) return p.enum[0];
    return { string: '...', number: 0, integer: 0, boolean: false, array: [], object: {} }[t] ?? '...';
  };
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, sample(props[k])])));
}
