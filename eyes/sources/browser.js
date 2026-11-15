// Browser source: Playwright MCP (`@playwright/mcp`, the swarm engine's `browser` server).
//
// target (which tab to look at):
//   undefined | null | '' | 'current'  the current tab (no extra MCP call)
//   number | '2' | { tab: 2 }           tab by index (selects it first)
//   any other string                    first tab whose URL or title contains it (selects it)
// Selecting a tab makes it the browser's current tab, so later clicks land on it too.

import { parseBrowserOutput, parseSnapshot, parseTabs } from '../parse.js';

export const name = 'browser';

/** True if this MCP connection is a Playwright MCP server. */
export function matches(conn) {
  return (conn?.tools ?? []).some((t) => t.name === 'browser_snapshot');
}

// Call through the raw MCP client: the swarm engine's callTool cuts text at 30k characters,
// which would cut big snapshots mid-tree. We budget the text ourselves.
async function call(conn, tool, args = {}) {
  const res = await conn.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120000 });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (res.isError) throw new Error(`${tool} failed: ${text.slice(0, 500)}`);
  return text;
}

/** Normalise a target to a stable key for per-target id state. */
export function targetKey(target) {
  if (target == null || target === '' || target === 'current') return 'browser:current';
  if (typeof target === 'object' && target.tab != null) return `browser:tab:${target.tab}`;
  if (typeof target === 'number' || /^\d+$/.test(String(target))) return `browser:tab:${Number(target)}`;
  return `browser:match:${target}`;
}

async function selectTarget(conn, target) {
  if (target == null || target === '' || target === 'current') return;
  const tabs = parseTabs(await call(conn, 'browser_tabs', { action: 'list' }));
  let index;
  if (typeof target === 'object' && target.tab != null) index = Number(target.tab);
  else if (typeof target === 'number' || /^\d+$/.test(String(target))) index = Number(target);
  else {
    const needle = String(target).toLowerCase();
    index = tabs.find((t) => t.url.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle))?.index;
    if (index === undefined) throw new Error(`no tab matches "${target}"`);
  }
  const tab = tabs.find((t) => t.index === index);
  if (!tab) throw new Error(`no tab ${index} (open: ${tabs.map((t) => t.index).join(', ') || 'none'})`);
  if (!tab.current) await call(conn, 'browser_tabs', { action: 'select', index });
}

/** Take one snapshot. Returns { page: { url, title, tabs, modal }, tree }. */
export async function snapshot(conn, target) {
  await selectTarget(conn, target);
  const out = await call(conn, 'browser_snapshot', {});
  const parsed = parseBrowserOutput(out);
  return {
    page: { url: parsed.url, title: parsed.title, tabs: parsed.tabs, modal: parsed.modal },
    tree: parseSnapshot(parsed.yaml ?? ''),
  };
}
