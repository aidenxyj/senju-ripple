// WebGames "date": type today's UTC date (YYYY-MM-DD) and submit.
import { webgamesTask, type, click } from '../../benchmarks/webgames/task.mjs';

export default webgamesTask({
  id: 'date',
  title: "Today's date",
  description: "Enter today's date",
  solve: [
    () => type('#date', new Date().toISOString().slice(0, 10), 'date field'),
    click('button[type=submit]', 'Check Date button'),
  ],
});
