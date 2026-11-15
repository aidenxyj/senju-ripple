// Tiny MCP server for the smoke test.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '0.0.1' });
server.tool('shout', 'Uppercase a string', { text: z.string() }, async ({ text }) => {
  await new Promise((r) => setTimeout(r, 200));
  return { content: [{ type: 'text', text: text.toUpperCase() }] };
});
await server.connect(new StdioServerTransport());
