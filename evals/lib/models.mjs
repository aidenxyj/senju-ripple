// Model clients for the eval runner. Every one has the swarm engine's shape: { create(params, { signal }) }.
//   ripple  adapter/ speaking to the Ripple endpoint in .env
//   stub    a scripted model that solves each task with the task's `stub` steps (checks the runner and the checkers)
//   noop    a scripted model whose worker gives up at once (every checker must fail)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uid = 0;
const use = (name, input = {}) => ({ type: 'tool_use', id: `s${++uid}`, name, input });
const say = (text) => ({ type: 'text', text });

export const textOf = (message) => typeof message.content === 'string' ? message.content
  : message.content.map((b) => b.type === 'text' ? b.text : (b.content ?? []).map((c) => c.text ?? '').join('')).join('\n');

export async function makeModel(name, { task, ctx } = {}) {
  if (name === 'ripple') {
    let mod;
    try { mod = await import('../../adapter/index.js'); } catch (err) {
      throw new Error(`--model ripple needs adapter/index.js exporting makeRippleLlm: ${err.message}`);
    }
    const { RIPPLE_BASE_URL: baseUrl, RIPPLE_API_KEY: apiKey, RIPPLE_MODEL: model, RIPPLE_MAX_CONTEXT } = process.env;
    if (!baseUrl || !apiKey || !model) throw new Error('--model ripple needs RIPPLE_BASE_URL, RIPPLE_API_KEY and RIPPLE_MODEL in .env');
    return { llm: mod.makeRippleLlm({ baseUrl, apiKey, model, maxContext: Number(RIPPLE_MAX_CONTEXT) || undefined }), model };
  }
  if (name === 'stub' || name === 'noop') return { llm: scripted(name, task, ctx), model: name };
  throw new Error(`unknown --model "${name}" (use ripple, stub or noop)`);
}

// One lead that spawns a single worker with the task's servers, then waits until it reports.
// The worker plays the task's stub steps in order (stub) or gives up straight away (noop).
function scripted(kind, task, ctx) {
  const turns = {};
  return {
    async create(params, { signal } = {}) {
      await sleep(5);
      if (signal?.aborted) throw new Error('aborted');
      const isLead = params.tools?.some((t) => t.name === 'spawn_agent');
      const who = isLead ? 'lead' : params.system[0].text.match(/^You are "([^"]+)"/)?.[1] ?? 'worker';
      const turn = turns[who] = (turns[who] ?? 0) + 1;
      const lastText = textOf(params.messages.at(-1));
      let content;
      if (isLead) {
        if (turn === 1) content = [use('spawn_agent', { name: 'Solver', goal: ctx.goal, servers: task.servers ?? [] })];
        else if (/No workers are running/.test(lastText)) content = [say('The worker reported back.')];
        else content = [use('wait')];
      } else if (kind === 'noop') {
        content = [say('I could not do this.')];
      } else {
        const steps = task.stub ?? [];
        const step = steps[turn - 1];
        if (!step) content = [say('Finished.')];
        else {
          const call = typeof step === 'function' ? step({ ctx, lastText }) : step;
          content = [use(call.name, call.input)];
        }
      }
      const toolUse = content.some((b) => b.type === 'tool_use');
      return { content, stop_reason: toolUse ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}
