// WebGames "buttons" (Button megastar): many decoys; only the text "this does nothing" reveals the password.
import { webgamesTask, evaluate } from '../../benchmarks/webgames/task.mjs';

export default webgamesTask({
  id: 'buttons',
  title: 'Button megastar',
  description: 'Click everything on the page to reveal the password',
  solve: [
    evaluate(`() => {
      const el = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === 'this does nothing');
      if (!el) return 'not found';
      el.click();
      return 'clicked';
    }`),
  ],
});
