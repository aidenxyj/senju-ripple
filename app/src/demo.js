// Demo mode (npm run demo): scripted fake agents, no API key, no MCP servers.
// Lets you check the overlay, cursors, idle state and dismiss without spending anything.
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); });
});

export const demoConfigServers = {
  browser: { app: 'Google Chrome', tile: 'demo' },
  files: { app: 'Finder', tile: 'demo' },
  terminal: { app: 'Terminal', tile: 'demo' },
};

export async function demoConnect(name) {
  const tools = {
    browser: ['navigate', 'click', 'read_page'],
    files: ['read_file', 'write_file'],
    terminal: ['run'],
  }[name] ?? ['noop'];
  return {
    name,
    tools: tools.map((t) => ({ name: t, description: t, inputSchema: { type: 'object', properties: {} } })),
    pid: null,
    client: { callTool: async () => { await sleep(900 + Math.random() * 1200); return { content: [{ type: 'text', text: 'ok' }] }; } },
    close: async () => {},
  };
}

let id = 0;
let replanned = false;
const use = (name, input = {}) => ({ type: 'tool_use', id: `d${++id}`, name, input });
const say = (text) => ({ type: 'text', text });
const textOf = (message) => typeof message.content === 'string' ? message.content
  : message.content.map((b) => b.type === 'text' ? b.text : (b.content ?? []).map((c) => c.text ?? '').join('')).join('\n');

function leadTurn(params) {
  const turns = params.messages.filter((m) => m.role === 'assistant').length;
  const last = textOf(params.messages.at(-1));
  if (turns === 0) {
    replanned = false;
    return [
      use('spawn_agent', { name: 'Research', goal: 'Find three sources in the browser', servers: ['browser'], needs_user: true }),
      use('spawn_agent', { name: 'Writer', goal: 'Draft the notes file', servers: ['files'] }),
      use('spawn_agent', { name: 'Runner', goal: 'Run the script on what the others produced', servers: ['terminal', 'files'], depends_on: ['Research', 'Writer'] }),
    ];
  }
  if (last.includes('do a short retrospective')) return [use('save_skill', { name: 'demo-research-and-notes', description: 'Use for demo jobs that research sources and draft notes.', body: 'Plan shape: one browser worker for research, one files worker for the draft, one runner that waits on both. Ask for the sign-in at the start. This skill was written by the demo.' })];
  if (last.includes('skill "demo-research-and-notes"')) return [say('Saved what the demo taught.')];
  if (last.includes('Message from the user')) return [say('Got it. I will steer the workers that way.'), use('wait')];
  if (!replanned && last.includes('"Research" finished')) {
    replanned = true;
    return [say('Research turned up more to verify, so I am adding a checker.'), use('spawn_agent', { name: 'Checker', goal: 'Double-check the three sources', servers: ['browser'] })];
  }
  if (last.includes('No workers are running')) return [say('Demo finished. The lead started three workers, added a fourth after the first report, and all reported back.')];
  return [use('wait')];
}

function workerTurn(params) {
  const turns = params.messages.filter((m) => m.role === 'assistant').length;
  const me = params.system?.[0]?.text ?? '';
  const last = textOf(params.messages.at(-1));
  const mcpTools = params.tools.filter((t) => t.name.includes('__'));
  const chat = last.includes('Message from the user') ? [say('Got it, adjusting.')] : [];
  if (turns === 1 && me.startsWith('You are "Research"')) {
    return [use('handoff', {
      reason: 'The site wants a sign-in before it shows results.',
      steps_for_user: 'In this window, sign in to the demo site. (Nothing to do in demo mode, just click Done.)',
      done_when: 'the results page is visible',
    })];
  }
  if (turns === 1 && me.startsWith('You are "Writer"')) {
    return [use('ask_user', { question: 'Which format do you want for the notes file?', options: ['Markdown', 'Plain text'] })];
  }
  if (turns === 1 && me.startsWith('You are "Checker"')) {
    return [use('user_task', {
      task: 'Plug the demo device into your Mac. (Nothing to plug in for the demo: just type any name and press Enter.)',
      where: 'Any USB port',
      done_when: 'the device shows up in the port list',
      reply_hint: 'the port name',
    })];
  }
  if (turns === 0 && me.startsWith('You are "Runner"')) return [say('Waiting for the others'), use('wait_for', { agents: ['Research', 'Writer'] })];
  if (turns >= 5 || mcpTools.length === 0) return [...chat, say('Finished my part of the demo.')];
  const tool = mcpTools[(turns * 2 + id) % mcpTools.length];
  return [...chat, say(['Opening the page', 'Reading results', 'Saving notes', 'Checking output', 'Wrapping up'][turns % 5]), use(tool.name)];
}

export const demoLlm = {
  async create(params, { signal } = {}) {
    await sleep(700 + Math.random() * 900, signal);
    const isLead = params.tools?.[0]?.name === 'spawn_agent';
    return { content: isLead ? leadTurn(params) : workerTurn(params) };
  },
};
