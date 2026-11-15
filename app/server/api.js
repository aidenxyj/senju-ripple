// The control page's HTTP API: session history, skills and memory, and team management.
// Every route needs a signed-in team member. Running and steering sessions happens over the hub's
// WebSocket from the desktop app, never here.
import { viewEvent } from './hub.js';

const MAX_BODY = 64_000;

// Handles /api/sessions, /api/skills, /api/memory and /api/team. Returns false for any other path.
export async function handleApi({ req, url, user, store, hub, json, readBody }) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);   // ['api', 'sessions', id]
  if (parts[0] !== 'api' || !['sessions', 'skills', 'memory', 'team'].includes(parts[1])) return false;
  if (!user) return json(401, { error: 'Sign in again.' });
  const team = await store.teamOf(user.id);
  if (!team) return json(403, { error: 'Create or join a team first.' });
  const body = () => readBody(req, MAX_BODY);
  const method = req.method;
  const [, area, id, sub, subId] = parts;

  // ---- Sessions ----
  if (area === 'sessions') {
    const live = hub?.live(team.id) ?? null;
    if (!id && method === 'GET') {
      const rows = await store.listSessions(team.id);
      return json(200, { sessions: rows.map((r) => ({ ...summaryOf(r, live), participant: r.participants.includes(user.id) || Boolean(live?.id === r.id && live.people.includes(user.id)) })) });
    }
    const row = id ? await store.getSession(id) : null;
    if (!row || row.teamId !== team.id) return json(404, { error: 'No such session in your team.' });
    const isLive = live?.id === row.id;
    const teamOwner = (await store.teamDetails?.(team.id))?.ownerId;
    const canManage = row.ownerId === user.id || teamOwner === user.id;
    if (method === 'GET') {
      // In it (now or in an earlier turn): the whole story, minus what is someone else's. Otherwise: the outline.
      const joined = row.participants.includes(user.id) || Boolean(isLive && live.people.includes(user.id));
      const events = (await store.listEvents(row.id))
        .filter((r) => !r.audience?.userId || r.audience.userId === user.id)
        .map((r) => {
          const e = viewEvent(r.event, user.id, joined);
          return e ? { turn: r.turn, at: r.at, event: e } : null;
        }).filter(Boolean);
      return json(200, { session: { ...summaryOf(row, live), participant: joined, canManage, turns: row.turns.map((t) => joined ? t : { goal: t.goal, ownerName: t.ownerName, started: t.started, ended: t.ended, status: t.status, summary: t.summary }) }, events });
    }
    if (!canManage) return json(403, { error: 'Only whoever started this session, or the team owner, can change it.' });
    if (method === 'PATCH') {
      const title = String((await body()).title ?? '').trim();
      if (!title) return json(400, { error: 'A session needs a title.' });
      await store.renameSession(row.id, title);
      return json(200, { ok: true });
    }
    if (method === 'DELETE') {
      if (isLive) return json(409, { error: 'That session is running. Stop it first.' });
      await store.deleteSession(row.id);
      return json(200, { ok: true });
    }
    return json(405, { error: 'Use GET, PATCH or DELETE.' });
  }

  // ---- Skills: team how-tos, every save kept as a revision ----
  if (area === 'skills') {
    if (!id && method === 'GET') return json(200, { skills: await store.skillDetails(team.id) });
    if (id && method === 'PUT') {
      const b = await body();
      try {
        return json(200, await store.saveSkill(team.id, { name: id, description: b.description, body: b.body }, user.id, null));
      } catch (err) { return json(400, { error: String(err?.message ?? err) }); }
    }
    if (id && method === 'DELETE') return json(200, { ok: await store.deleteSkill(team.id, id) });
    return json(405, { error: 'Use GET, PUT or DELETE.' });
  }

  // ---- Memory: notes about you (yours alone) and notes for the team ----
  if (area === 'memory') {
    if (!id && method === 'GET') return json(200, { notes: await store.listMemories(team.id, user.id) });
    if (!id && method === 'POST') {
      const b = await body();
      const note = String(b.note ?? '').trim().slice(0, 600);
      if (!note) return json(400, { error: 'The note is empty.' });
      await store.addMemory({ scope: b.scope === 'team' ? 'team' : 'user', teamId: team.id, subjectId: user.id, authorId: user.id, sessionId: null, note });
      return json(200, { ok: true });
    }
    if (id && method === 'DELETE') {
      const ok = await store.deleteMemory(team.id, user.id, id);
      return ok ? json(200, { ok }) : json(404, { error: 'No such note, or it is about someone else.' });
    }
    return json(405, { error: 'Use GET, POST or DELETE.' });
  }

  // ---- Team ----
  if (area === 'team') {
    const details = await store.teamDetails(team.id);
    const isOwner = details.ownerId === user.id;
    if (!id && method === 'GET') return json(200, { team: { ...details, me: user.id, isOwner } });
    if (!id && method === 'PATCH') {
      if (!isOwner) return json(403, { error: 'Only the team owner can rename the team.' });
      const name = String((await body()).name ?? '').trim();
      if (!name) return json(400, { error: 'A team needs a name.' });
      await store.renameTeam(team.id, name);
      return json(200, { ok: true });
    }
    if (id === 'invite' && method === 'POST') {
      if (!isOwner) return json(403, { error: 'Only the team owner can make a new invite code.' });
      return json(200, { inviteCode: await store.regenerateInvite(team.id) });
    }
    if (id === 'members' && sub && method === 'DELETE') {
      if (!isOwner) return json(403, { error: 'Only the team owner can remove people.' });
      if (sub === user.id) return json(400, { error: 'You own this team. To leave it, make someone else the owner first.' });
      await store.removeMember(team.id, sub);
      return json(200, { ok: true });
    }
    if (id === 'leave' && method === 'POST') {
      if (isOwner && details.members.length > 1) return json(400, { error: 'You own this team. Remove the others or hand it over before leaving.' });
      await store.removeMember(team.id, user.id);
      return json(200, { ok: true });
    }
    void subId;
    return json(405, { error: 'Not a team action.' });
  }
  return false;
}

// What a session list row shows.
function summaryOf(r, live) {
  const last = r.turns.at(-1);
  return {
    id: r.id, title: r.title, goal: r.goal, ownerName: r.ownerName, status: live?.id === r.id ? 'running' : r.status,
    live: live?.id === r.id, startedAt: r.startedAt, endedAt: r.endedAt, turnCount: r.turns.length,
    lastSummary: last?.summary ?? r.summary ?? null, costMicro: r.costMicro ?? null,
  };
}
