// MCP plumbing: connect to stdio servers, expose their tools to the model, run calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const MAX_TEXT = 30000;

export async function connectServer(name, spec) {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'senju', version: '0.1.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const conn = {
    name,
    spec,
    client,
    tools,
    pid: transport.pid ?? null,
    close: () => client.close().catch(() => {}),
  };
  await hideDriverCursor(conn);
  return conn;
}

// cua-driver draws its own agent cursor on top of Senju's ghost cursors. Run every call on this
// connection in one driver session of our own and hide that session's cursor. Set "driverCursor": true
// on the server in swarm.config.json to keep the driver's cursor.
const CURSOR_TOOLS = new Set(['start_session', 'end_session', 'set_agent_cursor_enabled']);
let cursorSeq = 0;

async function hideDriverCursor(conn) {
  if (conn.spec.driverCursor === true) return;
  if (!conn.tools.some((t) => t.name === 'set_agent_cursor_enabled')) return;
  const session = `senju-${process.pid}-${++cursorSeq}`;
  try {
    await conn.client.callTool({ name: 'start_session', arguments: { session } }, undefined, { timeout: 15000 });
    const res = await conn.client.callTool({ name: 'set_agent_cursor_enabled', arguments: { session, enabled: false } }, undefined, { timeout: 15000 });
    if (res.isError) return;
  } catch {
    return;   // an older driver: keep its cursor rather than fail to connect
  }
  conn.cursorSession = session;
  // Calls that take a session label all go to ours; agents never end it or turn its cursor back on.
  conn.tools = conn.tools.filter((t) => !CURSOR_TOOLS.has(t.name));
  conn.sessionTools = new Set(conn.tools.filter((t) => t.inputSchema?.properties?.session).map((t) => t.name));
  const close = conn.close;
  conn.close = async () => {
    await conn.client.callTool({ name: 'end_session', arguments: { session } }, undefined, { timeout: 5000 }).catch(() => {});
    await close();
  };
}

// Tool names must match [a-zA-Z0-9_-]{1,64}. We namespace as server__tool.
export function toolName(server, tool) {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// Build the model's tool list plus a lookup from tool name to (connection, MCP tool).
// Tools agents never get: a script that drives the page does many things at once, with no cursor to watch.
const HIDDEN_TOOLS = new Set(['browser_run_code_unsafe', 'browser_run_code']);

export function buildToolset(connections) {
  const tools = [];
  const lookup = new Map();
  for (const conn of connections) {
    for (const t of conn.tools) {
      if (HIDDEN_TOOLS.has(t.name)) continue;
      const name = toolName(conn.name, t.name);
      if (lookup.has(name)) continue;
      lookup.set(name, { conn, tool: t.name });
      const schema = t.inputSchema && t.inputSchema.type === 'object'
        ? t.inputSchema
        : { type: 'object', properties: {} };
      tools.push({
        name,
        description: `[${conn.name}] ${t.description ?? t.name}`.slice(0, 2000),
        input_schema: schema,
      });
    }
  }
  return { tools, lookup };
}

// Run one MCP call and convert the result into tool_result content.
export async function callTool(conn, tool, args, signal) {
  // How many calls are running on this connection now (background helpers wait for 0).
  conn.inflight = (conn.inflight ?? 0) + 1;
  if (conn.cursorSession && conn.sessionTools?.has(tool)) args = { ...args, session: conn.cursorSession };
  try {
    const res = await conn.client.callTool({ name: tool, arguments: args ?? {} }, undefined, { signal, timeout: 120000 });
    const content = [];
    for (const item of res.content ?? []) {
      if (item.type === 'text') {
        const text = item.text.length > MAX_TEXT
          ? item.text.slice(0, MAX_TEXT) + `\n[truncated ${item.text.length - MAX_TEXT} characters]`
          : item.text;
        content.push({ type: 'text', text });
      } else if (item.type === 'image' && item.data) {
        content.push({ type: 'image', source: { type: 'base64', media_type: item.mimeType ?? 'image/png', data: item.data } });
      } else if (item.type === 'resource' && item.resource?.text) {
        content.push({ type: 'text', text: item.resource.text.slice(0, MAX_TEXT) });
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: 'OK' });
    // structuredContent stays out of what the model reads; the app uses it (element frames, window lists).
    return { content, isError: Boolean(res.isError), structured: res.structuredContent };
  } catch (err) {
    return { content: [{ type: 'text', text: `Tool call failed: ${err?.message ?? err}` }], isError: true };
  } finally {
    conn.inflight -= 1;
  }
}

// Turn a server's config entry into what to launch for one agent: expand ${WORKSPACE}, and
// for a tiled browser server, start its window in the agent's slot on screen.
export function resolveSpec(spec, workspace, agent = null) {
  const args = (spec.args ?? []).map((a) => String(a).replaceAll('${WORKSPACE}', workspace));
  let { command, env } = spec;
  if (command === 'bundled') {
    // A server that ships inside the app: run its script with the app's own Node runtime,
    // so nothing needs to be installed on the computer first.
    command = process.execPath;
    args[0] = path.join(APP_ROOT, args[0]);
    env = { ...env, ELECTRON_RUN_AS_NODE: '1' };
  }
  if (spec.tile === 'playwright' && agent?.slot) {
    const { x, y, w, h } = agent.slot;
    const file = path.join(os.tmpdir(), `senju-${process.pid}-${agent.id}.json`);
    fs.writeFileSync(file, JSON.stringify({
      browser: {
        launchOptions: { args: [`--window-position=${x},${y}`, `--window-size=${w},${h}`] },
        contextOptions: { viewport: null },   // page follows the window size
      },
    }));
    args.push('--config', file);
  }
  return { ...spec, command, env, args };
}
