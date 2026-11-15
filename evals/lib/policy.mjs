// withPolicy(llm, { skill, policy }) -> llm
// Rewrites each request on its way to the model so a task's SKILL.md and knobs reach the swarm,
// without touching app/ or adapter/. The knobs (all optional) live in the skill's policy.json:
//
//   inject    "both" | "lead" | "workers" | "none"   where the SKILL.md method goes (default "both")
//   examples  "both" | "lead" | "workers" | "none"   where examples/*.md go (default "workers")
//   lead      { append: "text", drop: ["# Heading", ...] }   extra rules / prompt sections to remove
//   worker    { append: "text", drop: ["# Heading", ...] }
//   tools     { "<tool name>": "new description" }
//   sampling  { temperature, top_p, max_tokens }            passed through adapter/
//   bestOf    n: sample n replies at once, keep the first whose tool calls are all valid
import { invalidReason } from './meter.mjs';
import { hasMethod } from './skills.mjs';

export const isLead = (params) => Boolean(params.tools?.some((t) => t.name === 'spawn_agent'));
const wants = (where, lead) => where === 'both' || (lead ? where === 'lead' : where === 'workers');

/** Removes a "# Heading" section (up to the next heading of the same or a higher level) from a prompt. */
export function dropSection(text, heading) {
  const want = heading.trim();
  const level = want.match(/^#+/)?.[0].length ?? 1;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === want);
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !(lines[end].match(/^(#+)\s/)?.[1].length <= level)) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/** The text this policy adds to a lead's or a worker's system prompt. */
export function additions({ skill, policy = {} }, lead) {
  const parts = [];
  if (skill && hasMethod(skill.body) && wants(policy.inject ?? 'both', lead)) {
    parts.push(`# Playbook for this task\nThis method was learned from earlier runs of this kind of task. Follow it step by step. If the screen shows a step is wrong, adapt and say so in your report.\n\n${skill.body}`);
  }
  if (skill?.examples?.length && wants(policy.examples ?? 'workers', lead)) {
    parts.push(`# Worked example\nAn earlier run that succeeded. Your task's names and values are different: use the ones in your goal.\n\n${skill.examples.join('\n\n---\n\n')}`);
  }
  const extra = (lead ? policy.lead : policy.worker)?.append;
  if (extra) parts.push(extra);
  return parts.join('\n\n');
}

/** Applies the policy to one request. Pure: returns new params. */
export function applyPolicy(params, { skill, policy = {} } = {}) {
  const lead = isLead(params);
  const role = lead ? policy.lead : policy.worker;
  const blocks = Array.isArray(params.system) ? params.system : [{ type: 'text', text: String(params.system ?? '') }];
  let text = blocks[0]?.text ?? '';
  for (const h of role?.drop ?? []) text = dropSection(text, h);
  const add = additions({ skill, policy }, lead);
  if (add) text = `${text}\n\n${add}`;
  const system = [{ ...blocks[0], type: 'text', text }, ...blocks.slice(1)];
  const tools = policy.tools && params.tools
    ? params.tools.map((t) => (policy.tools[t.name] ? { ...t, description: policy.tools[t.name] } : t))
    : params.tools;
  const s = policy.sampling ?? {};
  return {
    ...params,
    system,
    ...(tools ? { tools } : {}),
    ...(s.temperature != null ? { temperature: s.temperature } : {}),
    ...(s.top_p != null ? { top_p: s.top_p } : {}),
    ...(s.max_tokens != null ? { max_tokens: s.max_tokens } : {}),
  };
}

/** Of several replies, the first whose tool calls are all valid; else the first with any tool call; else the first. */
export function pickBest(replies, tools = []) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const calls = (r) => (r.content ?? []).filter((b) => b.type === 'tool_use');
  return replies.find((r) => calls(r).length && calls(r).every((b) => !invalidReason(b, byName)))
    ?? replies.find((r) => calls(r).length)
    ?? replies[0];
}

export function withPolicy(llm, { skill = null, policy = {} } = {}) {
  const n = Math.max(1, Math.floor(policy.bestOf ?? 1));
  return {
    async create(params, opts) {
      const p = applyPolicy(params, { skill, policy });
      if (n === 1) return llm.create(p, opts);
      const settled = await Promise.allSettled(Array.from({ length: n }, () => llm.create(p, opts)));
      const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
      if (!ok.length) throw settled[0].reason;
      const best = pickBest(ok, p.tools);
      const usage = ok.reduce((u, r) => ({
        input_tokens: u.input_tokens + (r.usage?.input_tokens ?? 0),
        output_tokens: u.output_tokens + (r.usage?.output_tokens ?? 0),
      }), { input_tokens: 0, output_tokens: 0 });
      return { ...best, usage };
    },
  };
}
