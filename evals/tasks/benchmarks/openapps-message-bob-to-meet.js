// OpenApps-style (SendMessageTask "message_bob_to_meet"): send Bob "Let's meet"; Bob answers "Yes, let's play on Saturday!".
// Pass: one message to Bob saying "Let's meet" (case, curly quotes and end punctuation ignored), Bob's reply is there,
// and nobody else was messaged.
import { startOpenApps, sentSince, normText, REPLIES } from '../../benchmarks/openapps/apps.mjs';

const TO = 'Bob';
const MESSAGE = "Let's meet";

export default {
  id: 'openapps-message-bob-to-meet',
  goal: `My apps are at {url}. Send a message to ${TO} '${MESSAGE}'.`,
  servers: ['browser'],
  timeout: 240,
  async setup(ctx) { ctx.apps = await startOpenApps(); ctx.url = ctx.apps.url; },
  check({ apps }) {
    const sent = sentSince(apps.state);
    const others = Object.keys(sent).filter((c) => c !== TO);
    if (others.length) return { pass: false, detail: `also messaged ${others.join(', ')}` };
    const bob = sent[TO];
    if (!bob) return { pass: false, detail: `no message was sent to ${TO}` };
    if (!bob.mine.some((m) => normText(m.text) === normText(MESSAGE))) {
      return { pass: false, detail: `sent ${TO} ${bob.mine.map((m) => JSON.stringify(m.text)).join(', ')}, expected "${MESSAGE}"` };
    }
    if (!bob.all.some((m) => m.from === TO && m.text === REPLIES[TO])) return { pass: false, detail: `${TO}'s reply is missing` };
    return { pass: true, detail: `sent "${MESSAGE}", ${TO} replied "${REPLIES[TO]}"` };
  },
  teardown: ({ apps }) => apps?.close(),
  stub: [
    ({ ctx }) => ({ name: 'browser__browser_navigate', input: { url: `${ctx.url}messenger` } }),
    { name: 'browser__browser_click', input: { element: `${TO} contact link`, target: `a[href="/messenger?with=${TO}"]` } },
    { name: 'browser__browser_type', input: { element: 'Message field', target: '#message', text: MESSAGE } },
    { name: 'browser__browser_click', input: { element: 'Send button', target: '#send-message' } },
  ],
};
