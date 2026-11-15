// Find where other apps' windows are, so ghost cursors can park on them.
// macOS only. Uses the CoreGraphics window list through osascript (JXA), which
// returns owner names and bounds without needing any permission.
import { execFile } from 'node:child_process';

const JXA = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var opts = $.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements;
var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(opts, 0)));
JSON.stringify(list.filter(function (w) { return w.kCGWindowLayer === 0; }).map(function (w) {
  var b = w.kCGWindowBounds;
  return { app: w.kCGWindowOwnerName, pid: w.kCGWindowOwnerPID, id: w.kCGWindowNumber, x: b.X, y: b.Y, w: b.Width, h: b.Height, onScreen: Boolean(w.kCGWindowIsOnscreen) };
}));
`;

function run(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Front-to-back list of normal windows: [{app, pid, x, y, w, h}] in screen points.
// With { all: true }, also windows that are not showing: on another Space (desktop), minimized or hidden,
// marked onScreen: false. Otherwise only the windows on the current Space.
export async function listWindows({ all = false } = {}) {
  if (process.platform !== 'darwin') return [];
  const out = await run('osascript', ['-l', 'JavaScript', '-e', JXA]);
  try {
    return JSON.parse(out).filter((w) => w.w > 120 && w.h > 80 && (all || w.onScreen));
  } catch {
    return [];
  }
}

// Of several windows, one the user can see now if there is one.
const showing = (wins) => wins.find((w) => w.onScreen !== false) ?? wins[0] ?? null;

// Map of pid -> parent pid for every process.
export async function processParents() {
  const out = await run('ps', ['-axo', 'pid=,ppid=']);
  const parents = new Map();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid) parents.set(pid, ppid);
  }
  return parents;
}

function descendsFrom(pid, roots, parents) {
  for (let p = pid, hops = 0; p && hops < 32; p = parents.get(p), hops++) {
    if (roots.includes(p)) return true;
  }
  return false;
}

/**
 * Pick the window an agent's cursor should sit on.
 * First choice: a window owned by a process the agent's own MCP server launched
 * (for example the browser a Playwright server opened). Second: any window of
 * the app the server is mapped to. Otherwise null, and the UI parks the cursor.
 */
export function pickWindow(agent, appName, windows, parents, agentIndex) {
  // A desktop agent names the window or process it is driving in its tool calls.
  const t = agent.target;
  if (t?.windowId != null) { const w = windows.find((x) => x.id === t.windowId); if (w) return w; }
  if (t?.pid != null) { const w = showing(windows.filter((x) => x.pid === t.pid)); if (w) return w; }
  if (t?.app) { const w = showing(windows.filter((x) => (x.app ?? '').toLowerCase().includes(t.app.toLowerCase()))); if (w) return w; }
  if (agent.pids?.length) {
    const mine = showing(windows.filter((w) => descendsFrom(w.pid, agent.pids, parents)));
    if (mine) return mine;
  }
  if (appName) {
    const wanted = appName.toLowerCase();
    const matches = windows.filter((w) => (w.app ?? '').toLowerCase().includes(wanted));
    const here = matches.filter((w) => w.onScreen !== false);
    if (here.length) return here[agentIndex % here.length];
    if (matches.length) return matches[agentIndex % matches.length];
  }
  return null;
}
