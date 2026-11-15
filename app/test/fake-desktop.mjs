// A fake desktop driver for the smoke test: an app (pid 7) whose window 70 has a display showing the keys
// pressed. Each get_window_state reply is numbered, so a test can count the reads. Key "X" fails, key "n"
// opens a second window (71, "Untitled") and key "w" closes window 70.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-desktop', version: '0.0.1' });
let display = '';
let reads = 0;
let windows = [{ pid: 7, window_id: 70, title: 'Calc', on_current_space: true, is_on_screen: true }];
const ok = (text) => ({ content: [{ type: 'text', text }] });
server.tool('list_windows', 'List windows', { pid: z.number().optional() }, async () => ({ ...ok(`${windows.length} window(s)`), structuredContent: { windows } }));
server.tool('get_window_state', 'Read a window', { pid: z.number(), window_id: z.number(), tree_format: z.string().optional() }, async ({ window_id }) =>
  windows.some((w) => w.window_id === window_id) ? ok(`STATE #${++reads} window=${window_id} display=${display}`) : { ...ok(`No window ${window_id}`), isError: true });
server.tool('press_key', 'Press a key', { pid: z.number().optional(), window_id: z.number().optional(), key: z.string() }, async ({ key }) => {
  if (key === 'X') return { ...ok('press_key failed: no such key'), isError: true };
  if (key === 'n') windows = [...windows, { pid: 7, window_id: 71, title: 'Untitled', on_current_space: true, is_on_screen: true }];
  if (key === 'w') windows = windows.filter((w) => w.window_id !== 70);
  display += key;
  return ok(`Pressed ${key}`);
});
server.tool('click', 'Click', { pid: z.number().optional(), element_token: z.string().optional() }, async ({ element_token }) => { display += `[${element_token}]`; return ok(`Clicked ${element_token}`); });
await server.connect(new StdioServerTransport());
