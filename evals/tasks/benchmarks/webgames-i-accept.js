// WebGames "i-accept": tick the terms checkbox, then submit.
import { webgamesTask, click } from '../../benchmarks/webgames/task.mjs';

export default webgamesTask({
  id: 'i-accept',
  title: 'I accept',
  description: "Prove you're human by agreeing to our terms",
  solve: [
    click('#terms', 'I agree to the terms and conditions'),
    click('button[type=submit]', 'Submit button'),
  ],
});
