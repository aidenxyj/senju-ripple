// Small pieces of desktop-control logic shared by solo mode (the Swarm) and team mode (the ToolHost).

// Desktop tools that only look. Everything else may take the keyboard, so it waits for the user to pause.
export const READ_ONLY = /(^|_)(get|list|read|state|screenshot|snapshot|inspect|find|see|describe|doctor|permissions?|status|wait|sleep)(_|$)/i;

// Remember which app window a desktop agent is driving, so its cursor, cards and window slot
// follow it. Tool inputs name it by pid, window id, or app name.
export function noteTarget(agent, input) {
  if (!input || typeof input !== 'object') return;
  const num = (...keys) => { for (const k of keys) if (Number.isInteger(input[k])) return input[k]; return null; };
  const str = (...keys) => { for (const k of keys) if (typeof input[k] === 'string' && input[k].trim()) return input[k].trim(); return null; };
  const pid = num('pid', 'process_id', 'processId');
  const windowId = num('window_id', 'windowId');
  const app = str('app', 'app_name', 'appName', 'application', 'bundle_id', 'bundleId');
  if (pid == null && windowId == null && !app) return;
  const prev = agent.target ?? {};
  const samePid = pid == null || pid === prev.pid;
  agent.target = {
    pid: pid ?? prev.pid ?? null,
    windowId: windowId ?? (samePid ? prev.windowId ?? null : null),
    app: app ?? (samePid ? prev.app ?? null : null),
  };
}

// Is the user typing or clicking right now? Input an agent itself just produced does not count.
export function userActive(idleSeconds, lastAgentAction, threshold = 2) {
  if (idleSeconds == null) return false;
  if (idleSeconds >= threshold) return false;
  return (Date.now() - lastAgentAction) / 1000 > idleSeconds + 1.5;
}
