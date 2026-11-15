// MCP servers the eval tasks may ask for. Same servers as app/swarm.config.json,
// except the browser runs headless so evals do not open windows on your screen.
// `bundled` paths resolve against app/ (see resolveSpec in app/src/mcp.js).
export const SERVERS = {
  files: {
    command: 'bundled',
    args: ['node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', '${WORKSPACE}'],
    app: 'Finder',
    shared: true,
    about: 'Read and write files in the shared workspace folder',
  },
  browser: {
    command: 'bundled',
    // Snapshots and downloads go into the scratch folder, which the runner deletes after each task.
    args: ['node_modules/@playwright/mcp/cli.js', '--isolated', '--headless', '--output-dir', '${WORKSPACE}/.playwright-mcp'],
    app: 'Google Chrome',
    shared: false,
    about: 'A fresh headless Chrome per worker, for websites. Not signed in to anything',
  },
};

export function pickServers(names = []) {
  const out = {};
  for (const n of names) {
    if (!SERVERS[n]) throw new Error(`unknown server "${n}" (have: ${Object.keys(SERVERS).join(', ')})`);
    out[n] = SERVERS[n];
  }
  return out;
}
