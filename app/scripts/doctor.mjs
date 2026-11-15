// npm run doctor: checks that each configured MCP server starts, and records its tools.
// Writes traces/doctor.json so problems can be diagnosed from the file.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, loadConfig, ensureWorkspace } from '../src/config.js';
const ROOT = dataDir();
import { connectServer, resolveSpec, callTool } from '../src/mcp.js';
import { listWindows } from '../src/windows.js';
import { placeWindow } from '../src/place.js';

const config = loadConfig();
const workspace = ensureWorkspace();
const report = { when: new Date().toISOString(), platform: process.platform, node: process.version, servers: {}, windows: null, placement: null };

let driver = null;   // a running desktop driver that can move windows
for (const [name, spec] of Object.entries(config.servers)) {
  // Resolved the way the app does it: "bundled" servers run from this project's node_modules.
  const resolved = resolveSpec(spec, workspace);
  process.stdout.write(`${name}: starting (${spec.command} ${(spec.args ?? []).join(' ')}) ... `);
  try {
    const conn = await Promise.race([
      connectServer(name, resolved),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 90s')), 90000)),
    ]);
    report.servers[name] = { ok: true, tools: conn.tools.map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 600), input: t.inputSchema })) };
    console.log(`ok, ${conn.tools.length} tools: ${conn.tools.map((t) => t.name).join(', ')}`);
    if (!driver && conn.tools.some((t) => t.name === 'set_window_frame')) driver = conn; else await conn.close();
  } catch (err) {
    report.servers[name] = { ok: false, error: String(err?.message ?? err) };
    console.log(`FAILED: ${err?.message ?? err}`);
    if (spec.setup) console.log(`  -> ${spec.setup}`);
  }
}

const windows = await listWindows();
report.windows = { count: windows.length, apps: [...new Set(windows.map((w) => w.app))] };
console.log(`windows: ${windows.length ? `can see ${windows.length} windows (${report.windows.apps.slice(0, 8).join(', ')})` : 'none visible (window list failed)'}`);

// Placement check: "move" the front window to where it already is. Proves permission without changing anything.
// It is tried both ways the app can do it: through the desktop driver, then through System Events.
const front = windows[0];
if (front) {
  report.placement = {};
  if (driver) {
    const res = await callTool(driver, 'set_window_frame', { pid: front.pid, window_id: front.id, x: Math.round(front.x), y: Math.round(front.y), width: Math.round(front.w), height: Math.round(front.h) });
    const text = res.content.map((c) => c.text ?? '').join(' ').slice(0, 300);
    report.placement.driver = { ok: !res.isError, detail: text };
    console.log(`window tiling through the desktop driver: ${res.isError ? `failed (${text})` : 'allowed'}`);
  }
  const res = await placeWindow(front.pid, front);
  report.placement.systemEvents = res;
  const usable = report.placement.driver?.ok;
  console.log(`window tiling through System Events: ${res.ok ? 'allowed' : res.denied
    ? `not allowed (${res.error})${usable ? '. Not needed: the driver does it.' : '. Add the app you ran this from to System Settings > Privacy & Security > Accessibility, then quit and reopen it.'}`
    : `failed (${res.error ?? 'no window'})`}`);
}
await driver?.close();

fs.mkdirSync(path.join(ROOT, 'traces'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'traces', 'doctor.json'), JSON.stringify(report, null, 2));
console.log('\nWrote traces/doctor.json');
process.exit(0);
