// OpenApps-style (AddEventTask "add_meeting_with_dennis"): add an event titled Dennis-Bob on 2026-04-01.
// Pass: such an event exists and no seeded event was deleted.
import { startOpenApps, same, missingEvents } from '../../benchmarks/openapps/apps.mjs';

const TITLE = 'Dennis-Bob';
const DATE = '2026-04-01';

export default {
  id: 'openapps-add-meeting-with-dennis',
  goal: `My apps are at {url}. Go to the Calendar app and add my meeting with Dennis on April 1st of 2026. The title should be '${TITLE}'.`,
  servers: ['browser'],
  timeout: 240,
  async setup(ctx) { ctx.apps = await startOpenApps(); ctx.url = ctx.apps.url; },
  check({ apps }) {
    const { state } = apps;
    const gone = missingEvents(state);
    if (gone.length) return { pass: false, detail: `deleted existing events: ${gone.map((e) => e.title).join(', ')}` };
    const hit = state.events.find((e) => same(e.title, TITLE) && e.date === DATE);
    if (hit) return { pass: true, detail: `"${hit.title}" on ${hit.date}` };
    const near = state.events.find((e) => e.id >= 100);
    return { pass: false, detail: near ? `added "${near.title}" on ${near.date}, expected "${TITLE}" on ${DATE}` : 'no event was added' };
  },
  teardown: ({ apps }) => apps?.close(),
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: `${ctx.url}calendar` } }),
    { name: 'browser__browser_type', input: { element: 'Title field', target: '#title', text: TITLE } },
    { name: 'browser__browser_type', input: { element: 'Date field', target: '#date', text: DATE } },
    { name: 'browser__browser_click', input: { element: 'Add event button', target: '#add-event' } },
  ],
};
