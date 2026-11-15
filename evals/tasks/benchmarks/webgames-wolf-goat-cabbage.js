// WebGames "wolf-goat-cabbage": the river-crossing puzzle, one item in the boat at a time.
import { webgamesTask, evaluate } from '../../benchmarks/webgames/task.mjs';

// The classic 7-crossing solution, as the page's button labels.
const PLAN = [
  'Load goat', 'Move boat right', 'Unload', 'Move boat left',
  'Load wolf', 'Move boat right', 'Unload', 'Load goat', 'Move boat left', 'Unload',
  'Load cabbage', 'Move boat right', 'Unload', 'Move boat left',
  'Load goat', 'Move boat right', 'Unload',
];

export default webgamesTask({
  id: 'wolf-goat-cabbage',
  title: 'Wolf, goat and cabbage',
  description: 'Transport a wolf, goat, and cabbage across the river safely',
  solve: [
    evaluate(`async () => {
      const plan = ${JSON.stringify(PLAN)};
      const wait = () => new Promise((r) => setTimeout(r, 80));
      for (const label of plan) {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === label && !x.disabled);
        if (!b) return 'stuck at: ' + label;
        b.click();
        await wait();
      }
      return 'played ' + plan.length + ' moves';
    }`),
  ],
});
