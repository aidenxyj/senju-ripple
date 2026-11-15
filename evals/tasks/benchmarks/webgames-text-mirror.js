// WebGames "text-mirror": copy a two-paragraph text exactly into the text area, then submit.
import { webgamesTask, evaluate, type, click } from '../../benchmarks/webgames/task.mjs';

export default webgamesTask({
  id: 'text-mirror',
  title: 'Text mirror',
  description: 'Perfectly copy the text',
  solve: [
    evaluate(`() => 'TXT<<' + encodeURIComponent(document.querySelector('.whitespace-pre-wrap').textContent) + '>>'`),
    ({ lastText }) => type('textarea', decodeURIComponent(lastText.match(/TXT<<(.*?)>>/)?.[1] ?? ''), 'text area'),
    click('button[type=submit]', 'Submit button'),
  ],
});
