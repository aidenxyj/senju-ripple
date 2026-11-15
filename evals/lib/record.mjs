// recorder(llm, dir) -> { llm, calls, writeTranscript(header) }
// Wraps a model client and writes what each agent saw and did, for the autoresearch loop:
//   <dir>/calls.jsonl     one line per model call: who, the newest input, the reply (system prompt on each agent's first call)
//   <dir>/transcript.md   the same, readable, in call order (written by writeTranscript once the episode is over)
import fs from 'node:fs';
import path from 'node:path';
import { isLead } from './policy.mjs';

export function whoOf(params) {
  if (isLead(params)) return 'lead';
  const sys = Array.isArray(params.system) ? params.system[0]?.text : params.system;
  return String(sys ?? '').match(/^You are "([^"]+)"/)?.[1] ?? 'worker';
}

const flat = (content) => (typeof content === 'string' ? content : (content ?? []).map((c) => c.text ?? (c.type === 'image' ? '[image]' : '')).join('\n'));

/** One message as plain text: its text, tool calls and tool results. */
export function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content ?? []).map((b) => {
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_use') return `[call ${b.name}] ${JSON.stringify(b.input)}`;
    if (b.type === 'tool_result') return `[result${b.is_error ? ' ERROR' : ''}] ${flat(b.content)}`;
    return `[${b.type}]`;
  }).join('\n');
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more characters]` : s);

export function recorder(llm, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'calls.jsonl');
  const calls = [];
  const seen = new Set();
  let n = 0;
  const log = (entry) => { calls.push(entry); fs.appendFileSync(file, JSON.stringify(entry) + '\n'); };
  return {
    calls,
    llm: {
      async create(params, opts) {
        const who = whoOf(params);
        const first = !seen.has(who);
        seen.add(who);
        const entry = { i: ++n, who, t: new Date().toISOString() };
        if (first) {
          entry.system = Array.isArray(params.system) ? params.system.map((b) => b.text).join('\n') : String(params.system ?? '');
          entry.tools = (params.tools ?? []).map((t) => t.name);
        }
        entry.input = messageText(first ? params.messages[0] : params.messages.at(-1));
        const t0 = Date.now();
        try {
          const res = await llm.create(params, opts);
          log({ ...entry, ms: Date.now() - t0, stop: res.stop_reason, usage: res.usage,
            output: (res.content ?? []).map((b) => (b.type === 'tool_use' ? { type: 'tool_use', name: b.name, input: b.input } : { type: b.type, text: b.text })) });
          return res;
        } catch (err) {
          log({ ...entry, ms: Date.now() - t0, error: String(err?.message ?? err) });
          throw err;
        }
      },
    },
    /** Writes transcript.md. header: { title, lines: [] } shown above the calls. */
    writeTranscript({ title = 'Episode', lines = [] } = {}) {
      const out = [`# ${title}`, '', ...lines, ''];
      for (const c of [...calls].sort((a, b) => a.i - b.i)) {
        out.push(`## #${c.i} ${c.who}${c.ms != null ? ` (${(c.ms / 1000).toFixed(1)} s)` : ''}${c.stop ? ` → ${c.stop}` : ''}`, '');
        if (c.tools) out.push(`Tools: ${c.tools.join(', ')}`, '');
        out.push('**In:**', '```', cut(c.input ?? '', c.system ? 2500 : 1500), '```');
        if (c.error) out.push(`**Error:** ${c.error}`);
        for (const b of c.output ?? []) {
          if (b.type === 'tool_use') out.push(`**Call:** \`${b.name}\` ${cut(JSON.stringify(b.input), 600)}`);
          else if (b.text?.trim()) out.push(`**Says:** ${cut(b.text.trim(), 800)}`);
        }
        out.push('');
      }
      fs.writeFileSync(path.join(dir, 'transcript.md'), out.join('\n'));
    },
  };
}
