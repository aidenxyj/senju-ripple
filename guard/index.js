// guard/: checks every action before it runs. Contract: docs/SPEC.md, "guard/".
//
//   check(agent, action)          -> { allow: true } | { deny: true, reason } | { confirm: true, card }
//   record(agent, action, result) after an action runs, so check can spot loops
//   repair(call, schema)          -> { call } | { error }
//   guardLlm(llm, opts)           -> llm   wraps a model client: repairs tool calls and enforces the turn rules (turns.js)
//
// check and record share one default guard. Use createGuard() for an isolated one (one per swarm run, or in tests).
import { createGuard } from './check.js';

export { createGuard, classify, normalize } from './check.js';
export { repair, parseLoose, conform } from './repair.js';
export { guardLlm, reviewTurn, repairTurn, NUDGE_SPAWN, NUDGE_POST, NUDGE_ACT, NUDGE_SAID } from './turns.js';

const shared = createGuard();
export const check = (agent, action) => shared.check(agent, action);
export const record = (agent, action, result) => shared.record(agent, action, result);
export const reset = (agent) => shared.reset(agent);
