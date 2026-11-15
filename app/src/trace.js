// Per-job traces for diagnosing agent behavior.
// Each job gets a folder with one .jsonl file per agent (full detail) and a
// timeline.log (one readable line per event, all agents interleaved).
import fs from 'node:fs';
import path from 'node:path';

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}...` : s; };
const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, '_');

function summarize(kind, d) {
  switch (kind) {
    case 'response': {
      const calls = (d.calls ?? []).map((c) => c.name).join(', ');
      return `reply #${d.turn} stop=${d.stop ?? '?'} in=${d.usage?.input_tokens ?? '?'} out=${d.usage?.output_tokens ?? '?'}${d.usage?.cache_read_input_tokens ? ` cached=${d.usage.cache_read_input_tokens}` : ''}`
        + (d.text ? ` | says: ${clip(d.text, 160)}` : '') + (calls ? ` | calls: ${calls}` : '');
    }
    case 'tool': return `${d.name} -> ${d.isError ? 'ERROR ' : ''}${clip(d.result, 160)}`;
    case 'end': return `END reason=${d.reason} | ${clip(d.report, 200)}`;
    case 'error': return `ERROR ${clip(d.message, 240)}`;
    default: return `${kind}${d.note ? ` | ${clip(d.note, 200)}` : ''}`;
  }
}

export class Tracer {
  constructor(root, goal) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.dir = path.join(root, stamp);
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { this.dir = null; }
    this.write('swarm', 'goal', { note: goal });
  }

  write(who, kind, data = {}) {
    if (!this.dir) return;
    const t = new Date().toISOString();
    try {
      fs.appendFileSync(path.join(this.dir, `${safe(who)}.jsonl`), `${JSON.stringify({ t, kind, ...data })}\n`);
      fs.appendFileSync(path.join(this.dir, 'timeline.log'), `${t.slice(11, 19)} [${who}] ${summarize(kind, data)}\n`);
    } catch { /* tracing must never break a job */ }
  }
}

// Shape a model response for the trace: text plus tool calls with clipped inputs.
export function describeResponse(res, turn) {
  const content = res.content ?? [];
  return {
    turn,
    stop: res.stop_reason,
    usage: res.usage ? { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, cache_read_input_tokens: res.usage.cache_read_input_tokens, cache_creation_input_tokens: res.usage.cache_creation_input_tokens } : undefined,
    text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name, input: clip(JSON.stringify(b.input ?? {}), 1500) })),
  };
}

export const clipText = clip;
