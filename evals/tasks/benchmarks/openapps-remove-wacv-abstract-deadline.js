// OpenApps-style (RemoveEventTask "remove_wacv_abstract_deadline"): delete the WACV 2026 Abstract Deadline event.
// Trap: the WACV 2026 Paper Deadline sits next to it and must stay. Pass: the abstract deadline is gone, nothing else is.
import { startOpenApps, same, missingEvents } from '../../benchmarks/openapps/apps.mjs';

const TITLE = 'WACV 2026 Abstract Deadline';
const DATE = '2025-07-11';

export default {
  id: 'openapps-remove-wacv-abstract-deadline',
  goal: `My apps are at {url}. Remove the ${TITLE} event from my calendar.`,
  servers: ['browser'],
  timeout: 240,
  async setup(ctx) { ctx.apps = await startOpenApps(); ctx.url = ctx.apps.url; },
  check({ apps }) {
    const { state } = apps;
    const gone = missingEvents(state, [TITLE]);
    if (gone.length) return { pass: false, detail: `also deleted: ${gone.map((e) => e.title).join(', ')}` };
    if (state.events.some((e) => same(e.title, TITLE) && e.date === DATE)) return { pass: false, detail: `"${TITLE}" is still on the calendar` };
    return { pass: true, detail: `"${TITLE}" removed, other events kept` };
  },
  teardown: ({ apps }) => apps?.close(),
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: `${ctx.url}calendar` } }),
    { name: 'browser__browser_click', input: { element: `Delete ${TITLE} button`, target: '#delete-event-2' } },
  ],
};
