// WebGames "key-combo": hold Control + Shift + Y.
// The page tracks held keys in React state and drops a key that arrives before the previous one re-rendered, so all
// three keys pressed in the same instant (browser_press_key 'Control+Shift+Y', or `senju key ctrl+shift+y`) do not
// count. Holding them down one after another with a short pause does. The stub does that with real keyboard input.
import { webgamesTask } from '../../benchmarks/webgames/task.mjs';

export default webgamesTask({
  id: 'key-combo',
  title: 'Key combo',
  description: 'Press the correct key combination to unlock the secret',
  solve: [{
    name: 'browser__browser_run_code_unsafe',
    input: {
      code: `async (page) => {
        for (const k of ['Control', 'Shift', 'Y']) { await page.keyboard.down(k); await page.waitForTimeout(150); }
        for (const k of ['Y', 'Shift', 'Control']) await page.keyboard.up(k);
      }`,
    },
  }],
});
