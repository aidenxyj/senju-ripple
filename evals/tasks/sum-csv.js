// Files: read a CSV, compute a total, write the answer. Needs a read, some arithmetic, and a write.
import fs from 'node:fs';
import path from 'node:path';

const ROWS = [
  ['2026-11-01', 'Pens', '12.50'],
  ['2026-11-02', 'Paper', '40.00'],
  ['2026-11-03', 'Stapler', '18.25'],
  ['2026-11-04', 'Toner', '89.99'],
  ['2026-11-05', 'Folders', '7.30'],
  ['2026-11-06', 'Tape', '3.96'],
];
const TOTAL = 172.0;   // 12.50 + 40.00 + 18.25 + 89.99 + 7.30 + 3.96

export default {
  id: 'sum-csv',
  goal: 'The file {workspace}/sales.csv lists purchases. Add up the amount column and write the total, as a plain number with two decimals and nothing else, to {workspace}/total.txt',
  servers: ['files'],
  timeout: 180,
  setup({ workspace }) {
    const csv = ['date,item,amount', ...ROWS.map((r) => r.join(','))].join('\n') + '\n';
    fs.writeFileSync(path.join(workspace, 'sales.csv'), csv);
  },
  check({ workspace }) {
    const file = path.join(workspace, 'total.txt');
    if (!fs.existsSync(file)) return { pass: false, detail: 'total.txt was not created' };
    const text = fs.readFileSync(file, 'utf8').trim();
    const n = Number(text.replace(/[$,]/g, ''));
    if (!Number.isFinite(n)) return { pass: false, detail: `total.txt is not a number: ${JSON.stringify(text.slice(0, 80))}` };
    if (Math.abs(n - TOTAL) > 0.005) return { pass: false, detail: `total.txt says ${n}, expected ${TOTAL.toFixed(2)}` };
    return { pass: true, detail: `total ${TOTAL.toFixed(2)} is correct` };
  },
  stub: [
    ({ ctx }) => ({ name: 'files__read_text_file', input: { path: path.join(ctx.workspace, 'sales.csv') } }),
    ({ ctx, lastText }) => {
      const sum = lastText.split('\n').slice(1).map((l) => Number(l.split(',')[2])).filter(Number.isFinite).reduce((a, b) => a + b, 0);
      return { name: 'files__write_file', input: { path: path.join(ctx.workspace, 'total.txt'), content: sum.toFixed(2) } };
    },
  ],
};
