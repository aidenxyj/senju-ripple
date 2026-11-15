// WebGames "towers-of-hanoi": move 5 disks from the left peg to the right peg (31 moves).
// The disks are drawn as coloured bars with no text, so a text-only agent has to track the state itself;
// the start (all 5 on the left) and the rules are on the page.
import { webgamesTask, evaluate } from '../../benchmarks/webgames/task.mjs';

export default webgamesTask({
  id: 'towers-of-hanoi',
  title: 'Towers of Hanoi',
  description: 'Stack the disks on the rightmost peg following the rules',
  solve: [
    evaluate(`async () => {
      const moves = [];
      const hanoi = (n, from, to, via) => { if (!n) return; hanoi(n - 1, from, via, to); moves.push([from, to]); hanoi(n - 1, via, to, from); };
      hanoi(5, 0, 2, 1);
      const wait = () => new Promise((r) => setTimeout(r, 60));
      const pegButtons = () => [...document.querySelectorAll('button')].filter((b) => /^Select(ed)?$/.test(b.textContent.trim()));
      for (const [a, b] of moves) {
        pegButtons()[a].click(); await wait();
        pegButtons()[b].click(); await wait();
      }
      return 'played ' + moves.length + ' moves';
    }`),
  ],
});
