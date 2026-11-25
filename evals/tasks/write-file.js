// Files: create one file with exact contents.
import fs from 'node:fs';
import path from 'node:path';

const LINE = 'hello from senju';

export default {
  id: 'write-file',
  goal: `In the workspace folder {workspace}, create a file named hello.txt whose only content is the line: ${LINE}`,
  servers: ['files'],
  timeout: 180,
  setup() {},
  check({ workspace }) {
    const file = path.join(workspace, 'hello.txt');
    if (!fs.existsSync(file)) return { pass: false, detail: 'hello.txt was not created' };
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() !== LINE) return { pass: false, detail: `hello.txt holds ${JSON.stringify(text.slice(0, 80))}` };
    return { pass: true, detail: 'hello.txt is correct' };
  },
  stub: [
    ({ ctx }) => ({ name: 'files__write_file', input: { path: path.join(ctx.workspace, 'hello.txt'), content: `${LINE}\n` } }),
  ],
};
