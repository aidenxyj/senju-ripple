// Team mode, on each computer: runs the local tool servers on behalf of agents that live on
// the hub. The hub says "open the browser for agent a2" and "call click"; this does it here,
// with the same care as solo mode: tiled windows, one desktop action at a time, and waiting
// while the user is typing.
import { connectServer, callTool, resolveSpec } from './mcp.js';
import { READ_ONLY, noteTarget, userActive } from './desktop.js';

export class ToolHost {
  /**
   * @param {object} o
   * @param {object} o.config        the desktop app's swarm.config.json
   * @param {string} o.workspace
   * @param {(count: number) => object[]} [o.layout]  screen slots for agent windows
   * @param {() => number} [o.idle]  seconds since the user last typed or clicked
   * @param {(event: object) => void} [o.emit]  local-only UI events
   */
  constructor({ config, workspace, layout = null, idle = null, emit = () => {}, connect = connectServer }) {
    this.config = config;
    this.workspace = workspace;
    this.layout = layout;
    this.idle = idle;
    this.emit = emit;
    this.connect = connect;
    this.agents = new Map();   // agent id -> { id, name, color, server, pids, target, slot, live, status, label }
    this.conns = new Map();    // conn id -> { conn, server, agentId, shared }
    this.shared = new Map();   // server name -> connection kept open for every agent
    this.queues = new Map();   // server name -> tail of its serial queue
    this.grid = [];
    this.seq = 0;
    this.lastDesktopAction = 0;
    this.listing = null;
  }

  // What this computer offers: each working server with its tools. Started once and cached.
  catalog() {
    this.listing ??= (async () => {
      const out = {};
      await Promise.all(Object.entries(this.config.servers ?? {}).map(async ([name, spec]) => {
        try {
          const conn = await this.connect(name, resolveSpec(spec, this.workspace));
          out[name] = { about: spec.about ?? name, kind: spec.kind ?? null, app: spec.app ?? null, tile: spec.tile ?? null, tools: conn.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
          if (spec.shared) this.shared.set(name, conn); else await conn.close();
        } catch (err) {
          this.emit({ type: 'notice', message: spec.setup && /ENOENT|not found/i.test(String(err?.message ?? err))
            ? `"${name}" tools are not installed on this computer, so it will not offer them. ${spec.setup}`
            : `MCP server "${name}" failed to start: ${err?.message ?? err}` });
        }
      }));
      return out;
    })();
    return this.listing;
  }

  agent(info) {
    let a = this.agents.get(info.id);
    if (!a) { a = { id: info.id, name: info.name, color: info.color, server: null, pids: [], target: null, slot: null, live: true, status: 'starting', label: '' }; this.agents.set(a.id, a); }
    return a;
  }

  // Give an agent that opens its own window a slot on this screen, reusing freed ones.
  assignSlot(agent) {
    if (agent.slot || !this.layout) return;
    const holders = [...this.agents.values()].filter((a) => a.slot && a.live);
    let free = this.grid.filter((g) => !holders.some((a) => a.slot === g));
    if (free.length === 0) {
      if (holders.length === 0) free = this.grid = this.layout(1);
      else free = this.layout(holders.length + 1).slice(holders.length);   // may overlap older windows
    }
    agent.slot = free[0] ?? null;
  }

  async open(server, info) {
    const spec = this.config.servers?.[server];
    if (!spec) throw new Error(`This computer has no "${server}" server.`);
    const agent = this.agent(info);
    if (spec.tile) this.assignSlot(agent);
    let conn = this.shared.get(server);
    const isShared = Boolean(conn);
    if (!conn) {
      conn = await this.connect(server, resolveSpec(spec, this.workspace, agent));
      if (conn.pid) agent.pids.push(conn.pid);
    }
    const id = `c${++this.seq}`;
    this.conns.set(id, { conn, server, agentId: agent.id, shared: isShared });
    return { conn: id, tools: conn.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  }

  // Hold a desktop action until the user pauses, so it never lands in the middle of their typing.
  async quiet(agent) {
    const active = () => userActive(this.idle?.(), this.lastDesktopAction, this.config.typingPause ?? 2);
    if (!active()) return;
    const limit = Date.now() + (this.config.typingWaitMax ?? 120) * 1000;
    this.emit({ type: 'agent', id: agent.id, status: 'paused', label: 'waiting for you to pause', local: true });
    while (active() && Date.now() < limit) await new Promise((r) => setTimeout(r, 300));
  }

  async call(connId, tool, args) {
    const entry = this.conns.get(connId);
    if (!entry) return { content: [{ type: 'text', text: 'That tool connection is closed.' }], isError: true };
    const spec = this.config.servers?.[entry.server] ?? {};
    const agent = this.agents.get(entry.agentId);
    if (agent) agent.server = entry.server;
    const acts = spec.kind === 'desktop' && !READ_ONLY.test(tool);
    if (spec.kind === 'desktop' && agent) noteTarget(agent, args);
    const run = async () => {
      if (acts && agent) { await this.quiet(agent); this.lastDesktopAction = Date.now(); }
      const res = await callTool(entry.conn, tool, args);
      if (acts) this.lastDesktopAction = Date.now();
      return res;
    };
    if (!spec.serial) return run();
    // One desktop action at a time across all agents on this computer.
    const turn = (this.queues.get(entry.server) ?? Promise.resolve()).then(run, run);
    this.queues.set(entry.server, turn.catch(() => {}));
    return turn;
  }

  async close(connId) {
    const entry = this.conns.get(connId);
    if (!entry) return;
    this.conns.delete(connId);
    if (!entry.shared) await entry.conn.close();
  }

  // The session is over (or this computer left it): close what agents opened here.
  async endSession() {
    const open = [...this.conns.keys()];
    await Promise.all(open.map((id) => this.close(id)));
    this.agents.clear();
    this.grid = [];
  }

  async shutdown() {
    await this.endSession();
    await Promise.all([...this.shared.values()].map((c) => c.close()));
    this.shared.clear();
  }
}
