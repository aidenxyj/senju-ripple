// Move and resize another app's front window (macOS), so each agent's app sits in its own
// slot on screen. Uses System Events, which needs Accessibility and Automation permission
// for the app that launched Senju (usually Terminal). Fails soft if not allowed.
import { execFile } from 'node:child_process';

const SCRIPT = `
on run argv
  set thePid to (item 1 of argv) as integer
  set x to (item 2 of argv) as integer
  set y to (item 3 of argv) as integer
  set w to (item 4 of argv) as integer
  set h to (item 5 of argv) as integer
  tell application "System Events"
    set p to first application process whose unix id is thePid
    if (count of windows of p) is 0 then return "nowindow"
    set win to window 1 of p
    set {ox, oy} to position of win
    set {ow, oh} to size of win
    set position of win to {x, y}
    set size of win to {w, h}
    set position of win to {x, y}
    try
      perform action "AXRaise" of win
    end try
    return (ox as text) & "," & (oy as text) & "," & (ow as text) & "," & (oh as text)
  end tell
end run`;

/**
 * Put the front window of process `pid` at `rect` ({x, y, w, h} in screen points).
 * Resolves { ok, previous } with the window's earlier frame, or { ok: false, denied } when
 * macOS refuses (permission not granted) or the app has no window.
 */
export function placeWindow(pid, rect) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve({ ok: false });
    const args = ['-e', SCRIPT, String(pid), ...[rect.x, rect.y, rect.w, rect.h].map((n) => String(Math.round(n)))];
    execFile('osascript', args, { timeout: 6000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, denied: /not allowed|assistive|-1719|-25211|-1743/i.test(String(stderr)), error: String(stderr).trim().slice(0, 200) });
      const out = String(stdout).trim();
      if (out === 'nowindow') return resolve({ ok: false });
      const [x, y, w, h] = out.split(',').map(Number);
      resolve({ ok: true, previous: { x, y, w, h } });
    });
  });
}
