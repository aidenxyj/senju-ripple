// OpenApps-style (AddToDoTask "add_call_mom_to_my_todo"): add "Call Mom", not done.
// Pass: an open "Call Mom" item exists and the existing items are unchanged.
import { startOpenApps, same, changedTodos } from '../../benchmarks/openapps/apps.mjs';

const NAME = 'Call Mom';

export default {
  id: 'openapps-add-call-mom-to-my-todo',
  goal: `My apps are at {url}. Add '${NAME}' to my todo list.`,
  servers: ['browser'],
  timeout: 240,
  async setup(ctx) { ctx.apps = await startOpenApps(); ctx.url = ctx.apps.url; },
  check({ apps }) {
    const { state } = apps;
    const changed = changedTodos(state);
    if (changed.length) return { pass: false, detail: `changed or deleted existing items: ${changed.map((t) => t.name).join(', ')}` };
    const hit = state.todos.find((t) => same(t.name, NAME));
    if (!hit) {
      const added = state.todos.filter((t) => t.id >= 100).map((t) => t.name);
      return { pass: false, detail: added.length ? `added ${added.map((n) => `"${n}"`).join(', ')}, expected "${NAME}"` : 'nothing was added' };
    }
    if (hit.done) return { pass: false, detail: `"${NAME}" was added but marked done` };
    return { pass: true, detail: `"${hit.name}" added, not done` };
  },
  teardown: ({ apps }) => apps?.close(),
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: `${ctx.url}todo` } }),
    { name: 'browser__browser_type', input: { element: 'New to-do field', target: '#todo-name', text: NAME } },
    { name: 'browser__browser_click', input: { element: 'Add button', target: '#add-todo' } },
  ],
};
