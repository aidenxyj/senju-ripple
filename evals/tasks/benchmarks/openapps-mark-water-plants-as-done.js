// OpenApps-style (MarkToDoDoneTask "mark_water_plants_as_done"): mark "Water plants" done.
// Pass: it is done, still on the list, and no other item changed.
import { startOpenApps, same, changedTodos } from '../../benchmarks/openapps/apps.mjs';

const NAME = 'Water plants';

export default {
  id: 'openapps-mark-water-plants-as-done',
  goal: `My apps are at {url}. Mark '${NAME}' as done in my todo list.`,
  servers: ['browser'],
  timeout: 240,
  async setup(ctx) { ctx.apps = await startOpenApps(); ctx.url = ctx.apps.url; },
  check({ apps }) {
    const { state } = apps;
    const changed = changedTodos(state, [NAME]);
    if (changed.length) return { pass: false, detail: `also changed or deleted: ${changed.map((t) => t.name).join(', ')}` };
    const hit = state.todos.find((t) => same(t.name, NAME));
    if (!hit) return { pass: false, detail: `"${NAME}" was deleted instead of marked done` };
    if (!hit.done) return { pass: false, detail: `"${NAME}" is not marked done` };
    return { pass: true, detail: `"${NAME}" is done, other items unchanged` };
  },
  teardown: ({ apps }) => apps?.close(),
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: `${ctx.url}todo` } }),
    { name: 'browser__browser_click', input: { element: `Mark done: ${NAME} button`, target: '#toggle-todo-2' } },
  ],
};
