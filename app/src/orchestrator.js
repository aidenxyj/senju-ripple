// The swarm: one planner call splits the goal, then workers run in parallel.
// Each worker is a model tool loop over MCP tools. Events go to the UI via emit().
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectServer, buildToolset, callTool, resolveSpec } from './mcp.js';
import { pointBefore } from './point.js';
import { clearPopups } from './popups.js';
import { clickOnScreenKey } from './keys.js';
import { watchAds, onYouTube } from './adskip.js';
import { widenWindowState, rememberFrames, pointDesk, showLaunched, reveal, OFF_SPACE, lookAfter, ACTS } from './deskpoint.js';
import { READ_ONLY, noteTarget, userActive } from './desktop.js';
import { Tracer, describeResponse } from './trace.js';
import { listSkills, readSkill, saveSkill } from './skills.js';

const COLORS = ['#ff5d5d', '#4da3ff', '#39d98a', '#ffb648', '#b78bff', '#ff7ac8'];

// One reply policy for the lead and every worker when the user writes in mid-job: answer first, in plain text
// addressed to them, then act. A reply that acts without answering is discarded and asked again.
const USER_FIRST = 'The user comes first. They may write to you at any moment mid-job, and their message is the most current instruction. Whenever a message from the user appears, your very next reply must start with one or two lines of plain text answering them, before any tool call.';
const ANSWER_NOW = '(Answer the user now. Your visible reply must begin with one or two lines of plain text addressed to them, with the actual answer in it. Reasoning privately does not count: they only see your reply text. Then make your tool calls.)';
const ANSWER_AGAIN = 'You made tool calls without answering the user, so that reply was discarded. Their message is above. Write your answer to them as plain text first (what is done, what is in progress, what is blocked, or whatever they asked), then make your tool calls.';
const MAX_REPLY_NUDGES = 2;

// ---- Session traces ---------------------------------------------------------------
// Every model reply and tool call becomes a "step" event, so a session can be read back later.

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// A short, human description of what a tool call aims at: the page, the element, the key, the app.
export function stepLabel(name, input = {}) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys) => { for (const k of keys) if (input[k] != null && String(input[k]).trim()) return String(input[k]); return ''; };
  const tool = String(name).replace(/^.*__/, '');
  if (tool === 'spawn_agent') return `${pick('name')}: ${clip(pick('goal'), 120)}`;
  if (/^(message_agent|stop_agent)$/.test(tool)) return pick('agent');
  if (/^(ask_user|user_task|handoff)$/.test(tool)) return clip(pick('question', 'task', 'reason'), 120);
  if (/type|set_value/.test(tool)) return `${pick('element', 'target', 'element_token') ? `${clip(pick('element', 'target', 'element_token'), 50)} ← ` : ''}"${clip(pick('text', 'value'), 60)}"`;
  if (/key|hotkey/.test(tool)) return pick('key', 'keys', 'combo');
  if (/navigate|open/.test(tool)) return clip(pick('url', 'app', 'path'), 120);
  return clip(pick('element', 'target', 'url', 'app', 'app_name', 'query', 'path', 'name', 'note', 'title', 'function'), 120);
}

// The lead's conversation as it can be saved and resumed: no images, and no tool call left without a result.
export function snapshotMessages(messages) {
  const copy = JSON.parse(JSON.stringify(messages ?? []));
  for (const m of copy) {
    if (!Array.isArray(m.content)) continue;
    m.content = m.content.filter((b) => b.type !== 'image').map((b) => b.type === 'tool_result' && Array.isArray(b.content)
      ? { ...b, content: b.content.filter((c) => c.type !== 'image').length ? b.content.filter((c) => c.type !== 'image') : [{ type: 'text', text: '[image]' }] }
      : b);
  }
  return closeOpenCalls(copy);
}

export function closeOpenCalls(messages) {
  const last = messages.at(-1);
  const open = last?.role === 'assistant' && Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_use') : [];
  if (open.length) messages.push({ role: 'user', content: open.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: [{ type: 'text', text: 'Not run: the job ended.' }] })) });
  return messages;
}

const LEAD_SYSTEM = (maxAgents, team = false) => `You are the lead of a swarm of agents working on the user's computer. The user keeps using the computer while the swarm works. You do not act on apps yourself. You spawn workers, watch what they find, and adjust the plan as you learn more.

# Your loop
1. Spawn the first workers with spawn_agent. Put all spawns for one round in a single turn so they start together. Use as few workers as the goal needs; one is fine for a simple goal. At most ${maxAgents} can run at once.
2. Call wait. It returns when something happens: a worker finished or failed, a worker sent you a message, or the user wrote to you.
3. React, then wait again. Repeat until the goal is met.
4. When the goal is met and no workers are running, reply with a short final summary for the user (what got done, where the outputs are, anything that failed) and call no tools.
If the goal is a plain question you can answer without touching the computer, just answer it.
Jobs can run for hours. Your own history may be replaced by a summary partway through; if that happens, trust the summary, call board_read and wait to re-orient, and carry on rather than starting over.

# Replanning
Your first plan is a guess. Change it whenever a report or message shows the guess was wrong:
- A worker's result reveals more work, or different work: spawn workers for it.
- A worker is on the wrong track: message_agent to redirect it. Stop and replace it only if redirecting will not work.
- A worker failed, was cut short, or ran out of steps: read its report to see how far it got and why it stopped. Its report says what is done and what remains. Then decide whether to retry differently, route around it, or tell the user it cannot be done.
- Never start the same subtask the same way more than twice. A new browser worker means a new browser session and another sign-in for the user, so each retry costs them attention. If a second attempt also falls short, stop and tell the user what is blocking it, or ask them how to proceed.
- When you retry, give the new worker what the last one learned and a smaller or differently shaped task (for example, split a long write-up into parts).
- Work that is going fine should be left alone. Do not restart or duplicate it.

# Spawning well
- Give each worker a short name of one or two words, a self-contained goal with everything it needs to know, and only the tool servers it needs.
- When the user asks to find a website, page or link, the worker's goal must say to open it on screen by clicking the result, not only report its address.
- Keep each goal short (under about 80 words): what to do, where, and what to report. A long goal is slow to write and every worker waits for it. To pass on a method from a skill, list the skill in the worker's skills instead of copying it into the goal.
- If a worker needs another worker's output, list that worker in depends_on. A dependent worker still starts right away, does its own setup (such as getting the user signed in to its site), and then waits for the result. Declare real dependencies, but do not serialize work that could run in parallel. No circular dependencies.
- Set needs_user for a worker likely to need the user (a site that needs sign-in, a purchase, a message sent in their name), and word its goal so it reaches that step early. The user should be asked near the start, not interrupted repeatedly.
- Each browser worker has its own separate browser session, so each one that needs a signed-in site needs its own sign-in from the user. Prefer giving all work on one signed-in site to a single worker unless splitting it saves real time.
- Desktop workers drive the user's real apps, already signed in. Give each desktop worker one app (or two that must be used together), and never give the same app to two workers at once: an app has a single keyboard focus. Websites go to a browser worker unless the user wants them done in their own browser.
- A worker may read and draft in messaging and mail apps, but each send needs the user's approval. Say so in its goal, and plan for that pause.

# Skills from earlier jobs
After each job you write down what the swarm learned as a skill, and at the start of each job you are shown the list of skills so far.
- Before planning, read_skill any skill whose description fits this goal. Shape the plan by it.
- Pass the skills a worker needs in the skills field of spawn_agent, so it gets the working method up front instead of rediscovering it.
- A skill is a head start from a past job, not a guarantee. If a worker reports that a skill was wrong, note it for the retrospective.
- Do not call save_skill during the job. You will be asked for a retrospective when it is over.

# Talking with the user
${USER_FIRST} Then change the plan to match (spawn, redirect, or stop workers). If they ask about progress, say what is done, in progress, and blocked.
Use ask_user only for a decision you cannot make and that would be costly to guess. Workers handle their own sign-ins and confirmations.
Use user_task when the job needs the user to do something no worker can: connect or power a device, do something in the physical world, or act in an app no worker controls. Ask for it as early as you can, before workers start depending on it.
Workers cooperate on their own too: they message each other with tell_agent, claim shared things so they do not collide, and post to the board. You do not need to relay between them.
Text you write is shown to the user, so keep it short and plain.${team ? TEAM_LEAD_RULES : ''}`;

const DESKTOP_RULES = `
# Working in desktop apps
You can drive native Mac apps (the user's real apps, with their real accounts) through the desktop tools. The user is using this computer at the same time.
- Work in one window at a time. Read its state before you first act. After your actions the window's new state comes back with the last action's result, so check the result there instead of calling get_window_state again. Never assume an action worked: some apps echo a write without applying it, so check the result on screen.
- When you already know the next several actions and none depends on what the one before shows (keys on a keypad, the fields of a form, a menu and then its item), make them all in one reply: one action per tool call, in order. Each still happens visibly, one after another, and the window is read once after the last. Element tokens stay valid only until the window is read again, so take them all from the same reading, and do not batch past a step that opens a dialog, changes the page or decides what you do next.
- Act on elements in the background whenever the tools allow it. If an app ignores background input, you may bring it to the front for that single action, then let focus go back. Keep any such moment as short as possible and never hold the front window across several steps.
- If the app is not open, open it. If it shows a sign-in, a permission prompt or a system dialog, hand off to the user.
- Stay inside the apps your subtask needs. Do not touch Terminal or other shells, System Settings, password managers, banking or payment apps, or the Senju bar and cards, unless the user's goal names them explicitly. Leave other agents' windows alone.
- Do not close windows or documents that were open before you started, and do not quit apps you did not launch.

Messaging and mail apps (Slack, Discord, Messages, Mail, WhatsApp, Teams and the like):
- You may read and you may draft. You may never send, post, react, call or join on your own.
- Before anything is sent, call ask_user and show the exact text, the recipient or channel, and the app. Send only after a yes, and only that one message.
- In chat apps the Return key sends. Type drafts without a trailing newline, and never press Return or Enter in a chat box unless the user has just approved that exact message.
`;

const TEAM_LEAD_RULES = `

# Several people, several computers
This session is shared by a team. Each person may have one or more computers connected, and every tool server belongs to one computer: its name ends with the computer it runs on, and the list you are given says whose computer that is.
- One worker can use servers from more than one computer, which is how work moves between people's machines (read on one, write on another). Give a worker only the computers its subtask needs.
- A computer's owner approves its use once per session. Computers can join or leave mid-session; you are told when they do. Plan with what is connected now, and replan when that changes.
- Anything that needs hands at a computer (a sign-in, a user_task, a confirmation in an app) goes to the person at that computer. Tell the worker who that is.
- Any participant can write to you, and every message carries its author's name. Answer the person who asked, by name. If two people give instructions that conflict, do not pick one silently: say so and ask them to agree. The session owner decides if they cannot.
- Remembering: use remember when someone states a lasting preference or fact about how they or the team want things done. Attribute it to the person who said it. A personal preference is scope "person"; something the whole team should follow is scope "team", and only when a participant said it should apply to the team. Never record passwords, codes, or private details.
- Privacy between people: what is remembered about one person is for working with that person. Do not quote or paraphrase one person's personal notes to anyone else. Everyone in the session reads your chat replies, the board, worker reports and your final summary, so carry across only what the goal needs from someone's computer. Leave out their other messages, files, account names and anything else a worker happened to see there.`;

const TEAM_WORKER_RULES = `

# Several people share this session
Messages and answers carry the name of the person who wrote them. A sign-in, user_task or confirmation on a computer goes to the person at that computer, so word it for them. If two people tell you conflicting things, do not choose: tell_lead.
Your notes on the board and your report are read by everyone in the session. Take from a person's computer only what your subtask needs, and leave out anything else you happened to see there (other messages, files, account names).`;

const WORKER_SYSTEM = (agent, others, workspace, skillNotes = '', desktop = false, team = false) => `You are "${agent.name}", one agent in a swarm working in parallel on the user's computer. The user keeps using the computer while you work.

Your subtask: ${agent.goal}${agent.needsUser ? '\nThis subtask probably needs the user at some point. Get to that step early.' : ''}

Other agents in the swarm right now: ${others.length ? others.map((o) => `"${o.name}" (${o.goal})`).join('; ') : 'none'}. More may join later.
Shared workspace folder for files: ${workspace}

# How to work
- Act through your tools. Do only your subtask. Do not redo another agent's work.
- A browser worker's window is already open on a blank tab. Start with browser_navigate; do not list tabs first.
- When a game or tool shows its own on-screen keyboard or keypad (Wordle, a calculator), click its keys with browser_click, one key per call, and click its Enter key to submit each row, rather than typing on the keyboard.
- When your subtask is to find a website, page, profile or link, finish by opening it the way a person would: click the matching search result's link with browser_click (not browser_navigate to the address), check the page that opens is the right one, and leave it open on screen. Do not stop at reading or reporting the address.
- Clear anything that covers the page yourself, without asking the user: a cookie banner (accept or reject it), a newsletter or sign-up pop-up, an ad overlay or a chat bubble in the way. Click its close, "No thanks" or accept button with browser_click so the person sees the cursor do it, then carry on. Never close a box that asks the user to approve, pay or sign in for your task.
- The person watches your cursor, so work the way a person would: one visible action per call (browser_click, browser_type, browser_press_key, browser_select_option), in order, on the page's real buttons and fields. For a game, click each cell or key as a move. Read the page with browser_snapshot or browser_evaluate, but never use a script to click, type or play for you, and never do many actions in one call.
- The swarm shares a board. Use board_post to share a finding or partial result another agent could use now, without waiting until you finish. Posts by others reach you automatically on your next step, marked "New on the shared board"; use them if relevant and ignore them otherwise. board_read shows the whole board.
- Before each tool call, say in at most eight words what you are doing.
- Long content goes in pieces. When you have to enter a lot of text (a write-up, a long document), put it in through several tool calls of at most about 800 words each, not one giant call. A single oversized call gets cut off and nothing is saved.
- Long jobs: your older tool results are cleared from view as you go, and your history may be replaced by a summary. Before that can cost you anything, write down what you will need later: post key findings to the board, and save long work in progress to a file in the workspace folder when you have a files tool.
- If your history has been summarized, trust the summary, re-check the current page or file, and carry on from the next step. Do not start over.
- When finished, reply with a final report and call no more tools. Only stop when your subtask is actually complete or you are truly blocked; if you stop early, say exactly what is done and what remains.
- End your final report with a short "Lessons" section for future jobs: the method that worked for anything that took trial and error (name the exact tool and how you used it), the dead ends, and what you needed from the user. Methods only: no passwords, codes, or personal details.

# Working with the other agents
${agent.dependsOn.length ? `You depend on: ${agent.dependsOn.map((n) => `"${n}"`).join(', ')}. Start now with any setup that does not need their results, such as opening your site and getting the user signed in. When you need their results, call wait_for. It blocks until they finish and returns their final reports. Do not guess what they will produce, and do not redo their work while you wait.` : 'You do not depend on any other agent. If you later find you need another agent\'s result, call wait_for.'}
${agent.dependents.length ? `These agents are waiting for your result: ${agent.dependents.map((n) => `"${n}"`).join(', ')}. ` : ''}Your final report is what other agents and the user receive. Put the actual results in it (the numbers, the full text, the file path), not just a statement that you finished.
If an agent you depend on failed and you cannot do your subtask without it, stop and say so in your report.
tell_agent sends a short message straight to another agent: a result it needs right now, a question only it can answer, a warning. A reply, if there is one, arrives as a message. One message per need; do not chat.
Before you start changing something another agent might also touch (an app window, a document, a file), claim it with claim, and release it when you are done with it. If it is already held, do other work first or wait_for the holder. Claims are released for you when you finish.
A lead agent supervises the swarm and can change the plan. Call tell_lead when you learn something that changes the overall plan: the task is bigger or different than described, you are blocked by something the user cannot fix, or you see follow-up work outside your subtask. Keep working after telling it unless you are blocked.
${desktop ? DESKTOP_RULES : ''}
# Steps only the user can do
Signing in, two-factor codes, CAPTCHAs, payment details, and granting permissions belong to the user. When you reach one:
1. Stop acting in that window. Do not try to get around it, guess credentials, or look for another route to the same account.
2. Call handoff with: why you stopped, exactly what the user needs to do in which window, and how you will know it is finished (for example "the inbox is visible").
3. While you wait, do nothing in that window. The user is using it.
4. When handoff returns, do not assume it worked. Look at the page again and check your done_when condition. If it is not met, say what you see and hand off once more. After two failed handoffs, stop and report.
5. Then continue from where you left off, not from the beginning.
Never ask the user to type a password, code, or card number to you. They enter those directly into the page.

# When the user needs to do something somewhere else
Some steps need the user's own hands, and not in your window: typing or pasting something into another app, choosing a file, plugging in or switching on a device, anything in the physical world. Use user_task for these.
- Say exactly what to do and where, how you will know it is done, and what, if anything, they should type back to you (a port name, a file path, a value).
- It waits for as long as the user needs. Do not nag, and do not carry on with steps that depend on it.
- Afterwards, if you can check the result yourself (read the other window, list the ports, look for the file), do so. If it cannot be checked from here, take the user's Done as the answer.
- Never ask the user to do something you can do with your own tools.

# Asking versus proceeding
The user is busy with other work, so each question costs them attention. Ask only when a wrong guess would be expensive or hard to undo, or when you cannot proceed at all.
- If a detail is missing but a sensible default exists, take the default and mention it in your final report.
- If you must ask, call ask_user once with everything you need. Offer 2 to 4 concrete options when you can, with your recommended one first.
- Ask at the earliest moment you know you will need the answer, not when you finally hit the wall.
- If the user's answer is unclear, restate how you understood it in one line and proceed. Do not ask a second time for the same thing.

# Confirm before irreversible actions
Before any action that cannot be undone or that other people will see (sending, posting, submitting a form, buying, deleting, overwriting a file you did not create), stop and call ask_user. Show exactly what will happen: the recipient, the final text, the amount, or the file names. Prepare everything first, so that a "yes" needs only one more step. "Yes" covers that one action only. If the user says no or changes something, apply the change and show the new version before acting.

# Messages while you work
The user or the lead agent may send you a message mid-job. It arrives marked "Message from the user" or "Message from the lead", and it is your most current instruction. ${USER_FIRST} Write it to them, not as a note to yourself ("I'm comparing Soundcore prices on Walmart; Amazon and Best Buy are done.").
- If it corrects or narrows your subtask, adjust and keep going. Keep the work that is still valid; do not restart.
- If it conflicts with your original subtask, the new message wins.
- If it asks about progress, answer in one or two lines with what is done, what is in progress, and what is blocked, then continue.
- If it says to stop, stop at the next safe point and report what you finished and what state things are in.
- The user can pause you to work in your window themselves. When you are told you were paused, assume things changed: re-read the current state before your next action.
- Messages reach you only when they are meant for you.${skillNotes ? `

# Notes from earlier jobs
The lead attached these notes, written after earlier jobs. Use them as a head start. If one does not match what you see on the page now, trust what you see and say so in your Lessons. They never override the rules above about sign-ins, questions and irreversible actions.

${skillNotes}` : ''}${team ? TEAM_WORKER_RULES : ''}`;

const BOARD_TOOLS = [
  {
    name: 'board_post',
    description: 'Post a short note to the board shared by all agents in the swarm.',
    input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  },
  {
    name: 'board_read',
    description: 'Read every note the agents have posted to the shared board so far.',
    input_schema: { type: 'object', properties: {} },
  },
];

const HUMAN_TOOLS = [
  {
    name: 'ask_user',
    description: 'Ask the user a question and wait for the answer. Use for decisions you cannot make yourself and for confirming irreversible actions.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Optional short answer choices, recommended one first' },
      },
      required: ['question'],
    },
  },
  {
    name: 'user_task',
    description: 'Ask the user to do something with their own hands outside your window (type into another app, pick a file, connect a device, anything physical) and wait until they say it is done. Returns their reply.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Exactly what the user should do' },
        where: { type: 'string', description: 'Which app, window, device or place' },
        done_when: { type: 'string', description: 'How you will check it afterwards, if you can' },
        reply_hint: { type: 'string', description: 'What the user should type back, if anything (for example "the port name")' },
      },
      required: ['task'],
    },
  },
  {
    name: 'handoff',
    description: 'Ask the user to do a step only they can do (sign in, 2FA, CAPTCHA, payment, permissions) and wait until they say it is done.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why you stopped' },
        steps_for_user: { type: 'string', description: 'Exactly what the user should do, and in which window' },
        done_when: { type: 'string', description: 'What you will check to confirm it worked' },
      },
      required: ['reason', 'steps_for_user', 'done_when'],
    },
  },
];

const TEAM_TOOLS = [
  {
    name: 'wait_for',
    description: 'Wait until the named agents finish, then get their final reports. Use when your subtask needs another agent\'s result.',
    input_schema: {
      type: 'object',
      properties: { agents: { type: 'array', items: { type: 'string' }, description: 'Names of the agents to wait for' } },
      required: ['agents'],
    },
  },
  {
    name: 'tell_agent',
    description: 'Send a short message straight to another agent in the swarm. It reads it on its next step.',
    input_schema: { type: 'object', properties: { agent: { type: 'string' }, message: { type: 'string' } }, required: ['agent', 'message'] },
  },
  {
    name: 'claim',
    description: 'Claim a shared thing (an app window, a document, a file) before changing it, so no other agent changes it at the same time. Fails if another agent holds it.',
    input_schema: { type: 'object', properties: { resource: { type: 'string', description: 'A short name others would use for it, for example "Word: report.docx"' } }, required: ['resource'] },
  },
  {
    name: 'release',
    description: 'Release something you claimed.',
    input_schema: { type: 'object', properties: { resource: { type: 'string' } }, required: ['resource'] },
  },
  {
    name: 'tell_lead',
    description: 'Send a short message to the lead agent when you learn something that changes the overall plan.',
    input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
];

const leadTools = (serverNames, memory = false) => [
  {
    name: 'spawn_agent',
    description: 'Start a new worker agent on a subtask. Returns immediately; the worker runs in parallel.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'One or two words' },
        goal: { type: 'string', description: 'Self-contained subtask with everything the worker needs to know' },
        servers: { type: 'array', items: { type: 'string', enum: serverNames }, description: 'Tool servers the worker needs' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Names of workers whose output this one needs' },
        needs_user: { type: 'boolean' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Names of skills from earlier jobs to hand this worker' },
      },
      required: ['name', 'goal', 'servers'],
    },
  },
  {
    name: 'wait',
    description: 'Wait until something happens (a worker finishes, fails, or messages you, or the user writes to you). Returns what happened and the status of every worker.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'message_agent',
    description: 'Send an instruction or correction to a running worker. It reads it on its next step.',
    input_schema: { type: 'object', properties: { agent: { type: 'string' }, message: { type: 'string' } }, required: ['agent', 'message'] },
  },
  {
    name: 'stop_agent',
    description: 'Stop a running worker.',
    input_schema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] },
  },
  BOARD_TOOLS[1],
  HUMAN_TOOLS.find((t) => t.name === 'ask_user'),
  HUMAN_TOOLS.find((t) => t.name === 'user_task'),
  {
    name: 'read_skill',
    description: 'Read a skill written after an earlier job: the method that worked for a kind of task or a site.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'save_skill',
    description: 'Save what this job taught as a skill for future jobs, or replace an existing skill of the same name with an improved version. Use only in the retrospective after the job.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case name for the kind of task or site' },
        description: { type: 'string', description: 'One sentence: when a future job should use this skill' },
        body: { type: 'string', description: 'Instructions to a future agent, under 500 words' },
      },
      required: ['name', 'description', 'body'],
    },
  },
  ...(memory ? [{
    name: 'remember',
    description: 'Save a lasting preference or fact for future sessions, attributed to the person who stated it.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['person', 'team'], description: 'person: about one participant, visible only to them. team: for the whole team' },
        person: { type: 'string', description: 'Name of the participant who stated it' },
        note: { type: 'string', description: 'One or two sentences, in plain words' },
      },
      required: ['scope', 'person', 'note'],
    },
  }] : []),
];

const NOTE = (items) => items.map((m) => m.from === 'board' ? `New on the shared board from "${m.name}": ${m.text}`
  : m.from === 'agent' ? `Message from agent "${m.name}": ${m.text}`
  : m.from === 'system' ? `Notice: ${m.text}`
  : m.from === 'user' ? `Message from the user${m.name ? ` ${m.name}` : ''}: ${m.text}`
  : `Message from the lead: ${m.text}`).join('\n');


const RETRO = (existing, memory = false) => `The job is over and the user has your summary. Now do a short retrospective. It is for future jobs, not for the user.

Skills that already exist:
${existing.length ? existing.map((k) => `- ${k.name}: ${k.description}`).join('\n') : '(none yet)'}

Decide whether this job taught the swarm anything reusable: a method for a site or app that took trial and error, a plan shape that worked, a pitfall that cost time, a step the user always has to do. The workers' "Lessons" sections are your raw material.
- If yes, save it with save_skill. When an existing skill covers the same ground, read_skill it first and save the merged, corrected version under the same name. Do not create a near-duplicate. Fix anything in an existing skill that this job proved wrong.
- If the job taught nothing reusable, reply in one line saying so and call no tools.

What a good skill looks like:
- name: short kebab-case for the kind of task or the site (for example overleaf-write-latex), never this particular job.
- description: one sentence saying when a future job should use it.
- body: under 500 words, written as instructions to a future agent. Cover what applies: the plan shape (which workers, what depends on what), the method per site with the exact tool usage that worked, pitfalls and dead ends, and what needs the user (sign-ins and when to ask for them).
- Methods only. Never include passwords, codes, personal details, or the content of the user's work. Leave out one-off facts such as this week's problem numbers.
- Save at most two skills. One good one beats several thin ones.${memory ? `

Separately, if a participant stated a lasting preference or fact during this job that is not yet remembered, save it with remember, attributed to the person who said it. Skip anything that only mattered for this job.` : ''}`;

const MAX_SPAWNS = 24;      // total workers per job
// A worker turn is one short thought and one action, a few hundred tokens. The cap stops a turn that
// writes thousands (long candidate lists) from stalling the job for a minute; "workerMaxTokens" overrides it.
const WORKER_MAX_TOKENS = 2048;
const LEAD_MAX_TOKENS = 8000;

// Old tool results (page snapshots above all) dominate the context. Keep the most
// recent ones whole and shrink the rest, so long jobs do not hit the context limit.
function prune(messages, keep = 4, head = 400) {
  const withResults = messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  for (const m of withResults.slice(0, Math.max(0, withResults.length - keep))) {
    for (const block of m.content) {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      block.content = block.content.map((c) => {
        if (c.type === 'image') return { type: 'text', text: '[older image removed to save space]' };
        if (c.type === 'text' && c.text.length > head + 200) return { type: 'text', text: `${c.text.slice(0, head)}\n[rest of this older result removed to save space]` };
        return c;
      });
    }
  }
}

// What the server-side summary must keep when an agent's history is compacted.
const COMPACT_INSTRUCTIONS = `Summarize the working history of one agent in a multi-agent swarm so that it can carry on without the full history. Write it as a briefing addressed to that agent. Cover, in this order:
1. Its role and subtask, word for word where stated.
2. Every instruction or correction from the user or the lead agent, word for word, and every answer the user gave to a question.
3. What is finished, with the concrete results: values, text produced, file paths, URLs.
4. The exact current state: which site, page or file is open, whether it is signed in, what has been typed or saved so far.
5. What remains, in order, and the very next step.
6. Results received from other agents, and board posts that still matter.
7. What was tried and failed, so it is not tried again.
Keep specifics: numbers, names, identifiers, and the exact wording of any content that must be continued. Leave out page snapshots and routine tool chatter.`;

const CONTEXT_BETAS = ['context-management-2025-06-27', 'compact-2026-01-12'];
// The API rejected one of the long-run request features (not every model or account has them).
const featureRejected = (err) => err?.status === 400 && /context_management|context management|beta|compact|clear_tool_uses|cache_control/i.test(String(err?.message ?? ''));

const tooLong = (err) => err?.status === 400 && /too long|too large|context|maximum/i.test(String(err?.message ?? ''));
const MAX_LEAD_TURNS = 400;

export class Swarm {
  /**
   * @param {object} opts
   * @param {{create: Function}} opts.llm   object with create(params, {signal}) returning a message in the shape adapter/ returns (see llm.js)
   * @param {object} opts.config            parsed swarm.config.json
   * @param {string} opts.workspace         absolute path of the shared workspace folder
   * @param {(event: object) => void} opts.emit
   * @param {Function} [opts.connect]       override for tests
   * @param {Function} [opts.layout]        (count) => [{x, y, w, h}] screen rects for tiling agent windows
   */
  constructor({ llm, config, workspace, emit, connect = connectServer, layout = null, traceDir = null, skillsDir = null, idle = null, skills = null, memory = null, team = null }) {
    this.llm = llm;
    this.config = config;
    this.workspace = workspace;
    this.emit = emit;
    this.connect = connect;
    this.layout = layout;
    this.catalog = null;      // server name -> [{name, description}]
    this.shared = new Map();  // long-lived connections for servers marked shared
    this.kept = new Set();    // finished workers' own connections, kept open until the next job
    this.abort = null;
    this.agents = [];
    this.board = [];
    this.events = [];         // things the lead has not seen yet
    this.wake = null;         // resolves the lead's pending wait
    this.running = false;
    this.pending = new Map(); // question id -> resolver, for ask_user and handoff
    this.qseq = 0;
    this.leadChat = false;    // the lead owes the user a reply
    this.grid = [];           // current window slots on screen
    this.traceDir = traceDir; // folder for per-job traces, or null
    this.tracer = null;
    this.leadState = { interrupt: null, interrupted: false };
    // Skills come from a folder (solo) or from a shared store (teams). Same three operations either way.
    this.skills = skills ?? (skillsDir ? {
      list: async () => listSkills(skillsDir),
      read: async (name) => readSkill(skillsDir, name),
      save: async (skill) => saveSkill(skillsDir, skill),
    } : null);
    this.memory = memory;       // { notes(): text for the lead, remember({scope, person, note}): result text }, or null
    this.team = team;           // set when several people share the session
    this.learning = null;       // the retrospective still running after the last job
    this.learnAbort = null;
    this.leadCtx = null;
    this.idle = idle;           // () => seconds since the user last typed or clicked, or null if unknown
    this.lastDesktopAction = 0; // when an agent last acted on the desktop, to tell its input from the user's
    this.claims = new Map();    // resource -> name of the agent holding it
    // Server-side clearing, compaction and auto-caching. Off when the client says it has none (any OpenAI-style endpoint via adapter/),
    // or once the API rejects them; then prune() trims old tool results on the client instead.
    this.serverContext = llm?.serverContext !== false;
    this.usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.budgetWarned = false;
  }

  /**
   * Long-run request features, added to every model call:
   * - clear old tool results (page snapshots) once the context passes a threshold,
   * - compact the whole history into a summary at a higher threshold,
   * - cache the conversation prefix so each step re-reads it at a fraction of the cost.
   */
  // How hard the model thinks per call ("effort" in swarm.config.json: a level, or { lead, worker }).
  // Lower effort answers sooner; the default (no setting) is the model's own.
  effortParams(role) {
    const e = this.config.effort;
    const level = typeof e === 'string' ? e : e?.[role];
    return level ? { output_config: { effort: level } } : {};
  }

  longRunParams() {
    const c = this.config.context ?? {};
    if (!this.serverContext || c.enabled === false) return {};
    return {
      betas: CONTEXT_BETAS,
      cache_control: { type: 'ephemeral' },
      context_management: {
        edits: [
          {
            type: 'clear_tool_uses_20250919',
            trigger: { type: 'input_tokens', value: c.clearToolResultsAt ?? 200000 },
            keep: { type: 'tool_uses', value: c.keepToolResults ?? 10 },
            clear_at_least: { type: 'input_tokens', value: 20000 },
          },
          {
            type: 'compact_20260112',
            trigger: { type: 'input_tokens', value: Math.max(50000, c.compactAt ?? 500000) },
            instructions: COMPACT_INSTRUCTIONS,
          },
        ],
      },
    };
  }

  // Count tokens, report them, and enforce the job's token budget.
  account(who, res) {
    const u = res.usage ?? {};
    this.usage.calls++;
    this.usage.input += u.input_tokens ?? 0;
    this.usage.output += u.output_tokens ?? 0;
    this.usage.cacheRead += u.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.emit({ type: 'usage', ...this.usage });
    for (const block of res.content ?? []) {
      if (block.type === 'compaction') {
        this.trace(who, 'compaction', { note: block.content ? `history replaced by a summary: ${block.content}` : 'compaction produced no summary' });
        this.emit({ type: 'notice', tone: 'info', message: `${who === 'lead' ? 'The lead' : who} compacted its history to keep going.` });
      }
    }
    for (const edit of res.context_management?.applied_edits ?? []) {
      if (edit.cleared_input_tokens) this.trace(who, 'context', { note: `cleared ${edit.cleared_tool_uses ?? '?'} old tool results (${edit.cleared_input_tokens} tokens)` });
    }
    const budget = this.config.tokenBudget;
    if (!budget) return;
    const total = this.usage.input + this.usage.output + this.usage.cacheRead + this.usage.cacheWrite;
    if (total > budget * 1.5) {
      this.trace('swarm', 'error', { message: `token budget exceeded (${total} of ${budget}); stopping the job` });
      this.emit({ type: 'notice', message: `Stopped: the job went 50% past its token budget (${budget.toLocaleString()}). Raise tokenBudget in swarm.config.json to allow more.` });
      this.abort?.abort();
    } else if (total > budget && !this.budgetWarned) {
      this.budgetWarned = true;
      this.pushEvent({ kind: 'system', text: `The job has used its token budget (${budget.toLocaleString()} tokens). Wrap up now: let workers that are nearly done finish, stop the rest, and give the user a summary of what is done and what is not.` });
    }
  }

  get maxAgents() { return this.config.maxAgents ?? 4; }
  live() { return this.agents.filter((a) => a.live); }
  find(name) { return this.agents.find((a) => a.name.toLowerCase() === String(name ?? '').trim().toLowerCase()); }
  roster() {
    return this.agents.length
      ? `Workers: ${this.agents.map((a) => `${a.name} [${a.status}${a.status === 'blocked' || a.status === 'acting' ? `: ${a.label}` : ''}]`).join(', ')}`
      : 'No workers yet.';
  }

  serverSpec(name, agent = null) { return resolveSpec(this.config.servers[name], this.workspace, agent); }

  // Connect to every configured server once to learn its tools.
  async loadCatalog() {
    this.catalog = {};
    const names = Object.keys(this.config.servers ?? {});
    await Promise.all(names.map(async (name) => {
      try {
        const conn = await this.connect(name, this.serverSpec(name));
        this.catalog[name] = conn.tools.map((t) => ({ name: t.name, description: (t.description ?? '').split('\n')[0].slice(0, 120) }));
        if (this.config.servers[name].shared) this.shared.set(name, conn);
        else await conn.close();
      } catch (err) {
        const spec = this.config.servers[name];
        this.trace('swarm', 'error', { message: `MCP server "${name}" failed to start: ${err?.message ?? err}` });
        this.emit({ type: 'notice', message: spec.setup && /ENOENT|not found/i.test(String(err?.message ?? err))
          ? `"${name}" tools are not installed, so the swarm will work without them. ${spec.setup}`
          : `MCP server "${name}" failed to start: ${err?.message ?? err}` });
      }
    }));
    return this.catalog;
  }

  trace(who, kind, data) { this.tracer?.write(who, kind, data); }

  // One tool call, for the session trace. Input and result are clipped; the hub strips results before
  // anyone else sees them (tool results stay between the computer and the model).
  emitStep(agentId, call, result, isError, t0) {
    this.emit({
      type: 'step', agentId, kind: 'tool', tool: call.name, label: stepLabel(call.name, call.input),
      input: clip(JSON.stringify(call.input ?? {}), 300), result: clip(result, 600), isError, ms: Date.now() - t0, at: t0,
    });
  }

  // Calls to a server marked "serial" run one at a time across all agents, because
  // they share one screen and keyboard and must not interleave.
  inTurn(conn, fn) {
    const run = (conn.queue ?? Promise.resolve()).then(fn, fn);
    conn.queue = run.catch(() => {});
    return run;
  }

  // Is the user typing or clicking right now? Input the agents themselves just produced does not count.
  userActive() { return userActive(this.idle?.(), this.lastDesktopAction, this.config.typingPause ?? 2); }

  // Hold a desktop action until the user pauses, so it never lands in the middle of their typing.
  async quiet(agent, update, signal) {
    if (!this.userActive()) return;
    const before = { status: agent.status, label: agent.label };
    const limit = Date.now() + (this.config.typingWaitMax ?? 120) * 1000;
    update({ status: 'paused', label: 'waiting for you to pause' });
    while (this.userActive() && Date.now() < limit) {
      if (signal.aborted) throw new Error('cancelled');
      await new Promise((r) => setTimeout(r, 300));
    }
    update(before);
  }

  // The user paused this worker (to work in its window themselves). Wait here until they resume.
  async gate(agent, update, signal) {
    if (!agent.paused) return;
    const before = { status: agent.status, label: agent.label };
    const since = Date.now();
    update({ status: 'paused', label: 'paused by you' });
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      agent.resume = () => { signal.removeEventListener('abort', onAbort); agent.resume = null; resolve(); };
    });
    agent.inbox.push({ from: 'system', text: `The user paused you for ${Math.max(1, Math.round((Date.now() - since) / 1000))} seconds and may have changed things in your window. Re-read the current state before your next action.` });
    update(before);
  }

  // Pause or resume one worker, from the UI.
  setPaused(id, paused) {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent?.live) return false;
    agent.paused = Boolean(paused);
    this.trace(agent.name, 'status', { note: paused ? 'paused by the user' : 'resumed by the user' });
    if (!paused) agent.resume?.();
    else if (!agent.resume) this.emit({ type: 'agent', id: agent.id, status: agent.status, label: 'pausing after this step', server: agent.server, paused: true });
    return true;
  }

  // Stop one worker, from the UI. The lead hears about it like any other stop.
  stopAgent(id) {
    const agent = this.agents.find((a) => a.id === id);
    if (!agent?.live) return false;
    this.trace(agent.name, 'status', { note: 'stopped by the user' });
    this.pushEvent({ kind: 'system', text: `The user stopped "${agent.name}" themselves. Do not restart it unless they ask.` });
    agent.abort.abort();
    return true;
  }

  // Remember which app window a desktop agent is driving, so its cursor, cards and
  // window slot follow it. Tool inputs name it by pid, window id, or app name.
  noteTarget(agent, input) { noteTarget(agent, input); }

  /**
   * One model call that a user message can interrupt. If the user writes while the
   * call is in flight, it is aborted and reissued with their message included, so
   * the user never waits behind a long generation. prepare() folds pending messages
   * into the conversation and returns the request.
   */
  async think(owner, who, prepare, signal) {
    for (;;) {
      const turn = new AbortController();
      const onJob = () => turn.abort();
      signal.addEventListener('abort', onJob, { once: true });
      owner.interrupted = false;
      owner.interrupt = () => { owner.interrupted = true; turn.abort(); };
      try {
        const res = await this.llm.create(prepare(), { signal: turn.signal });
        if (signal.aborted) throw new Error('cancelled');
        this.account(who, res);
        if (signal.aborted) throw new Error('cancelled');
        if (owner.interrupted) { this.trace(who, 'interrupt', { note: 'user message arrived; discarding reply and asking again' }); continue; }
        return res;
      } catch (err) {
        if (signal.aborted) throw new Error('cancelled');
        if (this.serverContext && featureRejected(err)) {
          // Carry on without server-side context management; the client-side trim takes over.
          this.serverContext = false;
          this.trace(who, 'error', { message: `long-run request features rejected, continuing without them: ${err.message}` });
          this.emit({ type: 'notice', message: 'This model or account rejected server-side compaction, so the app is trimming history itself instead.' });
          continue;
        }
        if (!owner.interrupted) throw err;
        this.trace(who, 'interrupt', { note: 'user message arrived mid-call; asking again with it included' });
      } finally {
        owner.interrupt = null;
        signal.removeEventListener('abort', onJob);
      }
    }
  }

  // The lead's tools, rebuilt from whatever servers are connected right now.
  leadToolset() { return leadTools(Object.keys(this.catalog ?? {}), Boolean(this.memory)); }

  describeServer(name) {
    const spec = this.config.servers[name] ?? {};
    return `- ${name}: ${spec.about ?? `shows as ${spec.app ?? 'no app'}`}. Tools: ${(this.catalog[name] ?? []).map((t) => t.name).join(', ')}`;
  }

  // A computer joined mid-session and brought a tool server with it.
  addServer(name, spec, tools) {
    this.config.servers[name] = spec;
    this.catalog ??= {};
    const fresh = !this.catalog[name];
    this.catalog[name] = tools.map((t) => ({ name: t.name, description: (t.description ?? '').split('\n')[0].slice(0, 120) }));
    if (fresh && this.running) this.pushEvent({ kind: 'system', text: `A tool server is now available:\n${this.describeServer(name)}` });
  }

  // A computer left. Workers already using it will see their calls fail.
  removeServer(name) {
    if (!this.catalog?.[name]) return;
    delete this.catalog[name];
    delete this.config.servers[name];
    if (this.running) this.pushEvent({ kind: 'system', text: `The tool server "${name}" is no longer available: its computer disconnected. Workers that were using it will fail on their next call. Route around it or tell the user.` });
  }

  // read_skill and save_skill, shared by the job loop and the retrospective.
  async skillTool(call) {
    if (call.name === 'remember') {
      if (!this.memory) return 'Memory is not available in this session.';
      try { return await this.memory.remember(call.input ?? {}); } catch (err) { return `Not remembered: ${err.message}`; }
    }
    if (!this.skills) return 'Skills are turned off.';
    if (call.name === 'read_skill') {
      const skill = await this.skills.read(call.input?.name);
      if (!skill) return `No skill named "${call.input?.name}". Skills: ${(await this.skills.list()).map((k) => k.name).join(', ') || 'none'}.`;
      return `# ${skill.name}\n${skill.description}\n\n${skill.body}`;
    }
    try {
      const saved = await this.skills.save(call.input ?? {});
      this.trace('lead', 'skill', { note: `${saved.created ? 'created' : `updated to revision ${saved.revision}`}: ${saved.name} | ${saved.description}` });
      this.emit({ type: 'skill', ...saved });
      return `${saved.created ? 'Created' : 'Updated'} skill "${saved.name}".`;
    } catch (err) {
      return `Not saved: ${err.message}`;
    }
  }

  // After a job: the lead looks back and writes what was learned into a skill.
  // Runs in the background so the user is not kept waiting for it.
  async learn({ messages, system }) {
    const tools = this.leadToolset();
    const signal = (this.learnAbort = new AbortController()).signal;
    this.emit({ type: 'lead', status: 'thinking', label: 'writing down what it learned' });
    try {
      messages.push({ role: 'user', content: RETRO(await this.skills.list(), Boolean(this.memory)) });
      for (let turn = 0; turn < 6; turn++) {
        const res = await this.llm.create({ model: this.config.plannerModel ?? this.config.model, max_tokens: LEAD_MAX_TOKENS, system, tools, messages, ...this.longRunParams() }, { signal });
        if (signal.aborted) return;
        this.account('lead', res);
        this.trace('lead', 'response', describeResponse(res, `retro ${turn + 1}`));
        messages.push({ role: 'assistant', content: res.content });
        const calls = res.content.filter((b) => b.type === 'tool_use');
        if (calls.length === 0) break;
        const results = [];
        for (const call of calls) {
          const text = ['read_skill', 'save_skill', 'remember'].includes(call.name) ? await this.skillTool(call) : 'The job is over. Only the skill and memory tools work now.';
          results.push({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text }] });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      if (!signal.aborted) this.trace('lead', 'error', { message: `retrospective failed: ${err?.message ?? err}` });
    } finally {
      this.emit({ type: 'lead', status: 'idle', label: '' });
    }
  }

  // ---- The user ---------------------------------------------------------------

  // Show a question or handoff in the UI and wait for the user's reply.
  requestHuman(agentId, payload, signal) {
    const qid = `q${++this.qseq}`;
    return new Promise((resolve, reject) => {
      const onAbort = () => { this.pending.delete(qid); this.emit({ type: 'answered', qid }); reject(new Error('cancelled')); };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      const settle = (text) => {
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(qid);
        resolve(text);
      };
      settle.owner = agentId;
      this.pending.set(qid, settle);
      this.emit({ type: 'ask', qid, agentId, ...payload });
    });
  }

  answer(qid, text, who = null) {
    const resolve = this.pending.get(qid);
    if (!resolve) return;
    resolve(`${String(text ?? '').trim() || 'Done'}${who ? ` (from ${who})` : ''}`);
    this.emit({ type: 'answered', qid, text: clip(String(text ?? '').trim() || 'Done', 500), by: who ?? null });
  }

  // A chat message from the user, to the lead (default) or to one worker by id.
  tell(text, target = 'lead', who = null) {
    text = String(text ?? '').trim();
    if (!text || !this.running) return false;
    if (target === 'lead') {
      this.trace('lead', 'message', { note: `from user: ${text}` });
      this.pushEvent({ kind: 'user', text, name: who });
      this.leadState.interrupt?.();   // the user outranks whatever the lead was generating
      // If the lead is itself waiting on a question, the message releases it, so it can read
      // the message and answer. It asks again afterwards if it still needs to.
      for (const [qid, ask] of this.pending) {
        if (ask.owner !== 'lead') continue;
        ask('(not answered yet: the user wrote a message instead, shown below. Ask again afterwards if you still need this.)');
        this.emit({ type: 'answered', qid });
      }
      return true;
    }
    const agent = this.agents.find((a) => a.id === target);
    if (!agent?.live) return false;
    this.trace(agent.name, 'message', { note: `from user: ${text}` });
    agent.inbox.push({ from: 'user', text, name: who });
    agent.interrupt?.();
    agent.poke?.();
    return true;
  }

  // ---- Lead events --------------------------------------------------------------

  pushEvent(event) {
    this.events.push(event);
    this.wake?.();
  }

  drainEvents() {
    const lines = this.events.splice(0).map((e) => {
      if (e.kind === 'user') { this.leadChat = true; return `Message from the user${e.name ? ` ${e.name}` : ''}: ${e.text}`; }
      if (e.kind === 'note') return `"${e.name}" tells you: ${e.text}`;
      if (e.kind === 'system') return `System notice: ${e.text}`;
      return `"${e.name}" ${e.status}. Its report:\n${e.report}`;
    });
    const hasUser = lines.some((l) => l.startsWith('Message from the user'));
    return lines.join('\n\n') + (hasUser ? `\n\n${ANSWER_NOW}` : '');
  }

  async waitForEvents(signal) {
    if (this.events.length === 0 && this.live().length > 0) {
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
        this.wake = () => { signal.removeEventListener('abort', onAbort); this.wake = null; resolve(); };
      });
    }
  }

  // ---- Workers ------------------------------------------------------------------

  // Create a batch of workers (one lead turn's spawns), give them window slots, start them.
  spawnBatch(specs, jobSignal) {
    const serverNames = Object.keys(this.catalog);
    const results = [];
    const created = [];
    for (const spec of specs) {
      if (this.live().length + created.length >= this.maxAgents) {
        results.push(`Not started: at most ${this.maxAgents} workers can run at once. Wait for one to finish.`);
        continue;
      }
      if (this.agents.length + created.length >= MAX_SPAWNS) {
        results.push(`Not started: this job has reached its limit of ${MAX_SPAWNS} workers.`);
        continue;
      }
      let name = String(spec?.name ?? 'Worker').trim().slice(0, 24) || 'Worker';
      const taken = (n) => this.find(n) || created.some((a) => a.name.toLowerCase() === n.toLowerCase());
      for (let i = 2; taken(name); i++) name = `${String(spec.name).trim().slice(0, 21)} ${i}`;
      const index = this.agents.length + created.length;
      const agent = {
        id: `a${index + 1}`,
        name,
        goal: String(spec?.goal ?? ''),
        servers: (Array.isArray(spec?.servers) ? spec.servers : []).filter((sv) => serverNames.includes(sv)),
        color: COLORS[index % COLORS.length],
        needsUser: Boolean(spec?.needs_user),
        wants: (Array.isArray(spec?.depends_on) ? spec.depends_on : []).map(String),
        skills: (Array.isArray(spec?.skills) ? spec.skills : []).map(String),
        dependsOn: [],
        dependents: [],
        waitingOn: [],  // ids of agents this one is blocked on right now
        inbox: [],      // messages sent mid-job, delivered on the next turn
        chatPending: false,
        slot: null,     // screen rect for this agent's window, when tiling
        target: null,   // { pid, windowId, app } of the desktop window this agent is driving
        paused: false,  // the user paused this worker
        resume: null,
        server: null,   // server currently in use, drives where the ghost cursor parks
        pids: [],       // pids of this agent's own MCP server processes
        status: 'starting',
        label: '',
        live: true,
        endReason: null,
        interrupt: null,
        interrupted: false,
        poke: null,
        abort: new AbortController(),
      };
      agent.finished = new Promise((resolve) => { agent.finish = resolve; });
      jobSignal.addEventListener('abort', () => agent.abort.abort(), { once: true });
      created.push(agent);
      results.push(`Started "${name}".`);
    }
    // Window slots. Reuse slots freed by finished workers; otherwise lay the screen out again.
    const tiledNew = created.filter((a) => a.servers.some((sv) => this.config.servers[sv]?.tile));
    if (tiledNew.length && this.layout) {
      const holders = this.live().filter((a) => a.slot);
      let slots = this.grid.filter((g) => !holders.some((a) => a.slot === g));
      if (slots.length < tiledNew.length) {
        if (holders.length === 0) slots = this.grid = this.layout(tiledNew.length);
        else slots = this.layout(holders.length + tiledNew.length).slice(holders.length);   // may overlap older windows
      }
      tiledNew.forEach((a, i) => { a.slot = slots[i] ?? null; });
    }
    this.agents.push(...created);
    for (const a of created) {
      a.dependsOn = a.wants.map((n) => this.find(n)).filter((d) => d && d !== a).map((d) => d.name);
      for (const n of a.dependsOn) this.find(n).dependents.push(a.name);
      this.emit({ type: 'spawn', agent: { id: a.id, name: a.name, goal: a.goal, color: a.color, dependsOn: a.dependsOn } });
      this.trace(a.name, 'spawn', { note: `goal: ${a.goal} | servers: ${a.servers.join(', ') || 'none'} | depends on: ${a.dependsOn.join(', ') || 'nobody'} | skills: ${a.skills.join(', ') || 'none'}` });
    }
    for (const a of created) {
      a.promise = this.runWorker(a, a.abort.signal).then((report) => {
        a.live = false;
        const status = a.status === 'done' ? 'finished'
          : a.status === 'cancelled' ? 'was stopped'
          : a.endReason === 'step_limit' ? 'ran out of steps before finishing'
          : a.endReason === 'cut_off' ? 'kept hitting the output limit and stopped'
          : 'failed';
        this.trace(a.name, 'end', { reason: a.endReason ?? a.status, report });
        for (const [resource, holder] of this.claims) if (holder === a.name) this.claims.delete(resource);
        a.finish({ report, status });
        this.emit({ type: 'result', id: a.id, text: report });
        this.pushEvent({ kind: 'finished', name: a.name, status, report });
      });
    }
    return results;
  }

  // Block until the named agents finish. Returns text for the model.
  async waitFor(agent, names, signal) {
    const targets = [];
    for (const n of names) {
      const t = this.find(n);
      if (!t) return `No agent named "${n}". Agents: ${this.agents.map((a) => a.name).join(', ')}.`;
      if (t.id === agent.id) return 'You cannot wait for yourself.';
      targets.push(t);
    }
    if (targets.length === 0) return 'Name at least one agent to wait for.';
    // Refuse a wait that would deadlock: the target is already (indirectly) waiting on us.
    const reaches = (from, seen = new Set()) => from.waitingOn.some((id) => {
      if (id === agent.id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const next = this.agents.find((a) => a.id === id);
      return next ? reaches(next, seen) : false;
    });
    const stuck = targets.find((t) => reaches(t));
    if (stuck) return `Cannot wait: "${stuck.name}" is itself waiting on you. Finish what you can and report instead.`;

    agent.waitingOn = targets.map((t) => t.id);
    const aborted = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    const poked = new Promise((resolve) => { agent.poke = () => resolve('poked'); });
    try {
      const results = await Promise.race([Promise.all(targets.map((t) => t.finished)), aborted, poked]);
      if (results === 'poked') return 'Wait interrupted: a new message for you arrived (it follows). Deal with it, then call wait_for again if you still need those results.';
      return results.map((r, i) => `Report from "${targets[i].name}" (${r.status}):\n${r.report}`).join('\n\n');
    } finally {
      agent.waitingOn = [];
      agent.poke = null;
    }
  }

  async runWorker(agent, signal) {
    const update = (patch) => {
      const before = agent.status;
      Object.assign(agent, patch);
      this.emit({ type: 'agent', id: agent.id, status: agent.status, label: agent.label ?? '', server: agent.server, paused: agent.paused });
      if (patch.status && patch.status !== before && patch.status !== 'thinking' && patch.status !== 'acting') this.trace(agent.name, 'status', { note: `${patch.status}${agent.label ? `: ${agent.label}` : ''}` });
    };
    const takeInbox = () => {
      const items = agent.inbox.splice(0);
      const fromUser = items.some((m) => m.from === 'user');
      if (fromUser) agent.chatPending = true;
      return NOTE(items) + (fromUser ? `\n\n${ANSWER_NOW}` : '');
    };
    const own = [];
    try {
      update({ status: 'starting', label: 'connecting tools' });
      const conns = [];
      for (const name of agent.servers) {
        if (this.shared.has(name)) { conns.push(this.shared.get(name)); continue; }
        try {
          const conn = await this.connect(name, this.serverSpec(name, agent), agent);
          own.push(conn);
          conns.push(conn);
          if (conn.pid) agent.pids.push(conn.pid);
        } catch (err) {
          this.emit({ type: 'notice', message: `${agent.name}: could not start "${name}": ${err?.message ?? err}` });
        }
      }
      const { tools, lookup } = buildToolset(conns);
      const others = this.agents.filter((a) => a.id !== agent.id && a.live);
      const skillNotes = (this.skills ? await Promise.all(agent.skills.map((n) => this.skills.read(n))) : []).filter(Boolean).map((k) => `## ${k.name}\n${k.body}`).join('\n\n');
      const desktop = agent.servers.some((sv) => this.config.servers[sv]?.kind === 'desktop');
      const system = [{ type: 'text', text: WORKER_SYSTEM(agent, others, this.workspace, skillNotes, desktop, Boolean(this.team)), cache_control: { type: 'ephemeral' } }];
      const messages = [{ role: 'user', content: 'Begin your subtask now.' }];
      const maxSteps = this.config.maxSteps ?? 300;
      const allTools = [...tools, ...BOARD_TOOLS, ...TEAM_TOOLS, ...HUMAN_TOOLS];
      this.trace(agent.name, 'start', { note: `tools: ${allTools.map((t) => t.name).join(', ')}` });
      let finalText = '';
      let cutoffs = 0;
      let shrunk = false;
      let reported = false;
      let replyNudges = 0;
      const request = () => {
        if (agent.inbox.length) {
          const last = messages.at(-1);
          if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
          last.content.push({ type: 'text', text: takeInbox() });
        }
        if (!this.serverContext || this.config.context?.enabled === false) prune(messages);   // client-side fallback only
        return { model: this.config.workerModel ?? this.config.model, max_tokens: (this.config.workerMaxTokens ?? WORKER_MAX_TOKENS) * (cutoffs ? 4 : 1), system, tools: allTools, messages, ...this.longRunParams(), ...this.effortParams('worker') };
      };

      for (let step = 0; step < maxSteps; step++) {
        if (signal.aborted) throw new Error('cancelled');
        await this.gate(agent, update, signal);
        update({ status: 'thinking' });
        let res;
        try {
          res = await this.think(agent, agent.name, request, signal);
        } catch (err) {
          // Context overflow: shrink old results hard and try once more before giving up.
          if (!tooLong(err) || shrunk) throw err;
          shrunk = true;
          this.trace(agent.name, 'error', { message: `context too long, shrinking history and retrying: ${err.message}` });
          prune(messages, 1, 200);
          step--;
          continue;
        }
        this.trace(agent.name, 'response', describeResponse(res, step + 1));

        if (res.stop_reason === 'model_context_window_exceeded') {
          // The window itself is full. Drop the partial reply, shrink old results hard, and go again.
          if (shrunk) throw new Error('context window exceeded even after shrinking the history');
          shrunk = true;
          this.trace(agent.name, 'error', { message: 'context window exceeded; shrinking history and retrying' });
          prune(messages, 1, 200);
          step--;
          continue;
        }
        if (res.stop_reason === 'max_tokens') {
          // The reply was cut off mid-way, so any tool call in it is incomplete. Nothing ran.
          // A compaction block must be kept: it is now the start of the history.
          // No placeholder text goes into the history: the model copies it back as its whole answer ("(cut off)"),
          // which then reads as a finished report. The retry gets 4x the budget, so a long think can complete.
          const kept = res.content.filter((b) => b.type === 'compaction' || (b.type === 'text' && b.text.trim()));
          if (kept.length) messages.push({ role: 'assistant', content: kept });
          if (++cutoffs > 3) { agent.endReason = 'cut_off'; break; }
          const nudge = 'Your last reply hit the output limit before its tool call was complete, so nothing was done. Think in a few short sentences, not long lists, then make the tool call. Split long content across several smaller tool calls.';
          const last = messages.at(-1);
          if (last.role === 'user') {
            if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
            last.content.push({ type: 'text', text: nudge });
          } else messages.push({ role: 'user', content: nudge });
          continue;
        }
        cutoffs = 0;   // only cut-offs in a row end the worker
        const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
        const calls = res.content.filter((b) => b.type === 'tool_use');
        if (agent.chatPending && !text && replyNudges < MAX_REPLY_NUDGES && !res.content.some((b) => b.type === 'compaction')) {
          // Same policy as the lead: the user wrote in and this reply acted without answering them. It is
          // thrown away (its tool calls have not run) and the worker is asked again, more firmly.
          replyNudges++;
          this.trace(agent.name, 'interrupt', { note: 'reply had no text for the user; asking again' });
          const last = messages.at(-1);
          if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
          last.content.push({ type: 'text', text: ANSWER_AGAIN });
          continue;
        }
        messages.push({ role: 'assistant', content: res.content });
        if (text) {
          finalText = text;
          update({ label: text.slice(0, 80) });
          this.emit({ type: 'step', agentId: agent.id, kind: 'say', text: clip(text, 2000), at: Date.now() });
        }
        if (agent.chatPending) {
          agent.chatPending = false;
          replyNudges = 0;
          // Last resort if it still said nothing, as for the lead: a factual line from what it is doing.
          const next = calls.map((c) => c.name.replace(/^.*__/, '').replace(/_/g, ' '));
          this.emit({ type: 'chat', from: agent.id, name: agent.name, text: text || `Working on: ${agent.goal.slice(0, 200)}${next.length ? ` Next step: ${next.join(', ')}.` : ''}` });
        }
        if (calls.length === 0) {
          // A message that arrived during the final turn still gets a response.
          if (agent.inbox.length) { messages.push({ role: 'user', content: takeInbox() }); continue; }
          reported = true;
          break;
        }

        const results = [];
        let batchStopped = null;   // the desktop server whose batch stopped at a failure in this reply
        for (const [callIndex, call] of calls.entries()) {
          if (signal.aborted) throw new Error('cancelled');
          await this.gate(agent, update, signal);
          const t0 = Date.now();
          const say = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
          let out;
          if (call.name === 'board_post') {
            this.board.push({ from: agent.name, note: String(call.input?.note ?? '') });
            this.emit({ type: 'board', from: agent.name, note: String(call.input?.note ?? '') });
            // Blackboard push: every other working agent sees the post on its next step.
            for (const other of this.live()) {
              if (other.id !== agent.id) other.inbox.push({ from: 'board', name: agent.name, text: String(call.input?.note ?? '') });
            }
            out = say('Posted. The other agents will see it on their next step.');
          } else if (call.name === 'board_read') {
            out = say(this.board.length ? this.board.map((n) => `${n.from}: ${n.note}`).join('\n') : '(board is empty)');
          } else if (call.name === 'tell_lead') {
            this.pushEvent({ kind: 'note', name: agent.name, text: String(call.input?.message ?? '') });
            out = say('The lead has your message.');
          } else if (call.name === 'tell_agent') {
            const to = this.find(call.input?.agent);
            if (!to) out = say(`No agent named "${call.input?.agent}". Agents: ${this.agents.map((a) => a.name).join(', ')}.`);
            else if (to.id === agent.id) out = say('That is you.');
            else if (!to.live) out = say(`"${to.name}" has already finished. Its report is available through wait_for.`);
            else {
              to.inbox.push({ from: 'agent', name: agent.name, text: String(call.input?.message ?? '') });
              to.poke?.();
              this.trace(agent.name, 'message', { note: `to ${to.name}: ${String(call.input?.message ?? '')}` });
              out = say(`Delivered to "${to.name}".`);
            }
          } else if (call.name === 'claim' || call.name === 'release') {
            const resource = String(call.input?.resource ?? '').trim();
            const key = resource.toLowerCase();
            const holder = this.claims.get(key);
            if (!key) out = say('Name the thing to claim.');
            else if (call.name === 'release') {
              if (holder === agent.name) { this.claims.delete(key); out = say(`Released "${resource}".`); }
              else out = say(holder ? `"${resource}" is held by "${holder}", not you.` : `"${resource}" was not claimed.`);
            } else if (holder && holder !== agent.name) {
              out = say(`"${resource}" is held by "${holder}". Do other work first, or wait_for "${holder}" and try again.`);
            } else {
              this.claims.set(key, agent.name);
              out = say(`You hold "${resource}". Release it when you are done.`);
            }
          } else if (call.name === 'user_task') {
            update({ status: 'waiting', label: 'needs you' });
            const reply = await this.requestHuman(agent.id, {
              kind: 'task',
              task: String(call.input?.task ?? ''),
              where: String(call.input?.where ?? ''),
              doneWhen: String(call.input?.done_when ?? ''),
              replyHint: String(call.input?.reply_hint ?? ''),
            }, signal);
            out = say(`The user replied: ${reply}${call.input?.done_when ? '\nCheck the result yourself now, as you said you would.' : ''}`);
          } else if (call.name === 'wait_for') {
            const names = Array.isArray(call.input?.agents) ? call.input.agents : [];
            update({ status: 'blocked', label: `waiting for ${names.join(', ')}` });
            out = say(await this.waitFor(agent, names, signal));
          } else if (call.name === 'ask_user') {
            update({ status: 'waiting', label: 'needs you' });
            const reply = await this.requestHuman(agent.id, {
              kind: 'question',
              question: String(call.input?.question ?? ''),
              options: Array.isArray(call.input?.options) ? call.input.options.slice(0, 4).map(String) : [],
            }, signal);
            out = say(`The user answered: ${reply}`);
          } else if (call.name === 'handoff') {
            update({ status: 'waiting', label: 'needs you' });
            const reply = await this.requestHuman(agent.id, {
              kind: 'handoff',
              reason: String(call.input?.reason ?? ''),
              steps: String(call.input?.steps_for_user ?? ''),
              doneWhen: String(call.input?.done_when ?? ''),
            }, signal);
            out = say(`The user replied: ${reply}\nCheck your done_when condition yourself before continuing.`);
          } else {
            const hit = lookup.get(call.name);
            if (!hit) {
              out = say(`Unknown tool ${call.name}`, true);
            } else {
              update({ status: 'acting', server: hit.conn.name, label: `${hit.conn.name}: ${hit.tool}` });
              const spec = this.config.servers[hit.conn.name] ?? {};
              const desktopAct = spec.kind === 'desktop' && !READ_ONLY.test(hit.tool);
              // A batch of known actions stops at its first failure, so later steps never act out of order.
              const skipped = batchStopped === hit.conn && desktopAct;
              if (spec.kind === 'desktop' && !skipped) this.noteTarget(agent, call.input);
              // The person watches each cursor: a script that clicks, types or changes the page would act unseen.
              const scripted = hit.tool === 'browser_evaluate' && /\.click\(|dispatchEvent|\.value\s*=|\.submit\(|\.focus\(|innerHTML\s*=|textContent\s*=/.test(String(call.input?.function ?? ''));
              if (skipped) out = say('Not run: an earlier action in this reply failed, so the rest of the batch was stopped. Look at the window state returned with that failure and decide again.', true);
              else if (scripted) { out = say('Not run: browser_evaluate is for reading the page only. Do each click with browser_click, each entry with browser_type and each key with browser_press_key, one action per call, so the person can watch your cursor do it.', true); }
              const run = scripted || skipped ? null : async () => {
                // Hold the action while the user is typing or clicking, then act and note the time,
                // so the input this action produces is not mistaken for the user's.
                if (desktopAct) { await this.quiet(agent, update, signal); this.lastDesktopAction = Date.now(); }
                // A key the page shows as an on-screen button (a game keyboard, a calculator keypad): tap it with the cursor.
                if (spec.tile === 'playwright' && hit.tool === 'browser_press_key' && this.config.pointing !== false) {
                  const tapped = await clickOnScreenKey(hit.conn, call.input?.key, (point) => this.emit({ type: 'point', agentId: agent.id, point }), signal);
                  if (tapped) return { ...tapped, content: [{ type: 'text', text: `Clicked the on-screen "${call.input?.key}" key.` }, ...tapped.content] };
                }
                // A browser window of its own: send the ghost cursor to where this action lands first.
                if (spec.tile === 'playwright' && this.config.pointing !== false) await pointBefore(hit.conn, hit.tool, call.input, (point) => this.emit({ type: 'point', agentId: agent.id, point }), signal);
                const deskEmit = (point) => this.emit({ type: 'point', agentId: agent.id, point });
                // Only on this Mac, through the real desktop driver: never take over a teammate's screen.
                const canShow = spec.kind === 'desktop' && !this.team && hit.conn.tools?.some((t) => t.name === 'bring_to_front');
                // The first time a worker reads or acts on an app it did not launch (already open, maybe on another
                // desktop), take the person's screen there so they can watch.
                const firstPid = Number.isInteger(call.input?.pid) ? call.input.pid : null;
                if (canShow && firstPid && hit.tool !== 'launch_app' && this.config.showApps !== false && !(agent.shownPids ??= new Set()).has(firstPid) && /^(get_window_state|click|double_click|right_click|type_text|set_value|press_key|hotkey|scroll)$/.test(hit.tool)) {
                  agent.shownPids.add(firstPid);
                  const shown = await reveal(hit.conn, firstPid, call.input?.window_id ?? null, true).catch(() => null);
                  if (shown?.windowId) this.noteTarget(agent, { pid: firstPid, window_id: shown.windowId });
                }
                if (spec.kind === 'desktop' && this.config.pointing !== false) await pointDesk(agent, hit.tool, call.input, deskEmit);
                const input = spec.kind === 'desktop' ? widenWindowState(hit.tool, call.input) : call.input;
                let res = await callTool(hit.conn, hit.tool, input, signal);
                if (desktopAct) this.lastDesktopAction = Date.now();
                // On YouTube: from now on, skip each video ad with the cursor as soon as its Skip button shows.
                if (spec.tile === 'playwright' && !res.isError && !hit.conn.adWatch && this.config.skipAds !== false && onYouTube(res, call.input)) {
                  watchAds(hit.conn, (point) => this.emit({ type: 'point', agentId: agent.id, point }), (label) => this.trace(agent.name, 'note', { note: `skipped a video ad ("${label}")` }));
                }
                if (spec.kind === 'desktop') {
                  rememberFrames(agent, hit.tool, res);
                  // A launched app should be seen opening: show its window and let the cursor and slot follow it.
                  if (canShow && hit.tool === 'launch_app' && !res.isError) {
                    const shown = await showLaunched(hit.conn, res);
                    if (shown?.pid) { (agent.shownPids ??= new Set()).add(shown.pid); this.noteTarget(agent, { pid: shown.pid, ...(shown.windowId ? { window_id: shown.windowId } : {}) }); }
                    if (shown?.note) res = { ...res, content: [...res.content, { type: 'text', text: shown.note }] };
                  }
                  // Refused because the window is on another Space: bring it here, and say so, so the retry works.
                  const errText = res.isError ? res.content.filter((c) => c.type === 'text').map((c) => c.text).join(' ') : '';
                  const pid = Number.isInteger(call.input?.pid) ? call.input.pid : agent.target?.pid;
                  if (canShow && errText && OFF_SPACE.test(errText) && pid && (agent.revealTries ?? 0) < 3) {
                    agent.revealTries = (agent.revealTries ?? 0) + 1;
                    const shown = await reveal(hit.conn, pid, call.input?.window_id ?? agent.target?.windowId ?? null).catch(() => null);
                    if (shown?.windowId) this.noteTarget(agent, { pid, window_id: shown.windowId });
                    if (shown?.note) res = { ...res, content: [...res.content, { type: 'text', text: shown.note }] };
                  }
                }
                // Act and look in one step: after the last desktop action of this reply (or the one that failed, which
                // ends the batch), read the window and hand it back with the result, so the worker does not spend a
                // model turn on get_window_state to check.
                const lastHere = !calls.slice(callIndex + 1).some((c) => lookup.get(c.name)?.conn === hit.conn);
                if (spec.kind === 'desktop' && ACTS.test(hit.tool) && res.isError) batchStopped = hit.conn;
                if (spec.kind === 'desktop' && ACTS.test(hit.tool) && (lastHere || res.isError) && this.config.lookAfterActions !== false) {
                  const seen = await lookAfter(hit.conn, agent, signal);
                  if (seen) res = { ...res, content: [...res.content, { type: 'text', text: `${seen.note ? `${seen.note}\n` : ''}The window now (read for you after this action, with fresh element tokens; no need to call get_window_state to check):` }, ...seen.res.content], structured: res.structured };
                }
                // A page that just opened under a cookie banner or pop-up: close it the way a person would, with
                // the cursor, and give the worker the page as it is now.
                if (spec.tile === 'playwright' && hit.tool === 'browser_navigate' && !res.isError && this.config.closePopups !== false) {
                  const cleared = await clearPopups(hit.conn, (point) => this.emit({ type: 'point', agentId: agent.id, point }), signal);
                  if (cleared?.result) {
                    this.trace(agent.name, 'note', { note: `closed ${cleared.closed.join(', ')}` });
                    return { ...cleared.result, content: [{ type: 'text', text: `Opened ${call.input?.url ?? 'the page'}. It opened under a ${cleared.closed.join(' and then a ')}, so that was closed for you. The page now:` }, ...cleared.result.content] };
                  }
                }
                return res;
              };
              if (run) out = spec.serial ? await this.inTurn(hit.conn, run) : await run();
            }
          }
          this.trace(agent.name, 'tool', { name: call.name, isError: Boolean(out.isError), result: out.content.map((c) => c.type === 'text' ? c.text : `[${c.type}]`).join(' ').slice(0, 1500) });
          this.emitStep(agent.id, call, out.content.map((c) => c.type === 'text' ? c.text : `[${c.type}]`).join(' '), Boolean(out.isError), t0);
          results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: out.isError });
        }
        messages.push({ role: 'user', content: results });
      }

      if (!reported) {
        // Out of steps (or cut off repeatedly). Get an honest account of where things stand,
        // so the lead can pick up from here instead of starting over blind.
        agent.endReason ??= 'step_limit';
        const why = agent.endReason === 'cut_off' ? 'Your replies kept hitting the output limit' : `You have used all ${maxSteps} of your steps`;
        const ask = `${why}, so you must stop now. Do not call any tools. Write your final report: what is finished, what remains, and the exact state things are in (which page, what has been typed or saved).`;
        const last = messages.at(-1);
        if (last.role === 'user') {
          if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
          last.content.push({ type: 'text', text: ask });
        } else {
          messages.push({ role: 'user', content: ask });
        }
        try {
          const res = await this.llm.create({ model: this.config.model, max_tokens: 2000, system, tools: allTools, messages, ...this.longRunParams() }, { signal });
          this.account(agent.name, res);
          const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
          if (text) finalText = text;
        } catch { /* keep the last note we have */ }
        update({ status: 'error', label: agent.endReason === 'cut_off' ? 'output limit' : 'out of steps' });
        return `Not finished. ${finalText || 'No report available.'}`;
      }
      agent.endReason = 'reported';
      update({ status: 'done', label: 'done' });
      return finalText || 'Finished.';
    } catch (err) {
      const cancelled = signal.aborted;
      if (!cancelled) this.trace(agent.name, 'error', { message: `${err?.status ? `HTTP ${err.status} ` : ''}${err?.message ?? err}` });
      agent.endReason = cancelled ? 'stopped' : 'error';
      update({ status: cancelled ? 'cancelled' : 'error', label: cancelled ? 'stopped' : String(err?.message ?? err).slice(0, 80) });
      return cancelled ? 'Stopped before finishing.' : `Failed: ${err?.message ?? err}`;
    } finally {
      // A finished worker's own windows stay on screen so the result can be seen; the next job or shutdown closes them.
      if (this.config.keepWindows === false || signal.aborted) await Promise.all(own.map((c) => c.close().catch(() => {})));
      else for (const c of own) this.kept.add(c);
      agent.pids = [];
    }
  }

  // ---- The lead -------------------------------------------------------------------

  async runLead(goal, signal, resume = null) {
    const lead = (status, label = '') => this.emit({ type: 'lead', status, label });
    const serverList = Object.keys(this.catalog).map((name) => this.describeServer(name)).join('\n');
    const system = [{ type: 'text', text: LEAD_SYSTEM(this.maxAgents, Boolean(this.team)), cache_control: { type: 'ephemeral' } }];
    const skills = this.skills ? await this.skills.list() : [];
    const memoryNotes = this.memory ? await this.memory.notes() : '';
    const skillList = skills.length ? `\n\nSkills from earlier jobs (read the ones that fit before you plan):\n${skills.map((k) => `- ${k.name}: ${k.description}`).join('\n')}` : '';
    const setting = `Tool servers workers can use:\n${serverList || '(none)'}\nShared workspace folder for files: ${this.workspace}${this.team?.brief ? `\n\n${this.team.brief}` : ''}${memoryNotes ? `\n\nRemembered from earlier sessions:\n${memoryNotes}` : ''}${skillList}`;
    let messages;
    if (resume?.messages?.length) {
      // A session picked up again: the lead keeps its whole conversation. Workers, windows and browsers
      // from last time are gone, so it is told what it has now and plans afresh from the new message.
      messages = closeOpenCalls(JSON.parse(JSON.stringify(resume.messages)));
      const note = `The user has come back to this session${resume.gap ? ` after ${resume.gap}` : ''} and continues it. The workers from before have ended and their windows may be closed; spawn new workers for anything that still needs doing.\n\n${setting}\n\nNew message from the user${resume.by ? ` (${resume.by})` : ''}: ${goal}`;
      const last = messages.at(-1);
      if (last?.role === 'user') {
        if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
        last.content.push({ type: 'text', text: note });
      } else {
        messages.push({ role: 'user', content: note });
      }
    } else {
      messages = [{ role: 'user', content: `${setting}${this.lastJob ? `\n\nThe previous job, for context only (the new goal may follow on from it, e.g. "continue", "do it again", "now send that to Bob"; if it does not, ignore this):\nGoal: ${this.lastJob.goal}\nResult: ${this.lastJob.summary}` : ''}\n\nGoal: ${goal}` }];
    }
    this.leadCtx = { messages, system };
    let replyNudges = 0;
    let leadShrunk = false;   // shrank the history once after the context window filled up
    let nudged = false;   // told once that workers are still running; after that a text-only reply just keeps waiting
    let lastText = '';

    const request = () => {
      // Anything that happened while the lead was busy rides along with the next request.
      if (this.events.length) {
        const last = messages.at(-1);
        if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
        last.content.push({ type: 'text', text: `Updates:\n${this.drainEvents()}` });
      }
      if (this.leadChat) lead('thinking', 'reading your message');
      if (!this.serverContext || this.config.context?.enabled === false) prune(messages);   // client-side fallback only
      return { model: this.config.plannerModel ?? this.config.model, max_tokens: LEAD_MAX_TOKENS, system, tools: this.leadToolset(), messages, ...this.longRunParams(), ...this.effortParams('lead') };
    };

    for (let turn = 0; turn < MAX_LEAD_TURNS; turn++) {
      if (signal.aborted) throw new Error('cancelled');
      lead('thinking', this.agents.length ? 'reviewing' : 'planning');
      const res = await this.think(this.leadState, 'lead', request, signal);
      this.trace('lead', 'response', describeResponse(res, turn + 1));
      if (res.stop_reason === 'model_context_window_exceeded' && !res.content.some((b) => b.type === 'tool_use' || (b.type === 'text' && b.text.trim()))) {
        // The window itself is full and nothing came back. Asking for a briefer reply would not help:
        // shrink old results hard and go again, once.
        if (leadShrunk) throw new Error('lead context window exceeded even after shrinking the history');
        leadShrunk = true;
        this.trace('lead', 'error', { message: 'context window exceeded; shrinking history and retrying' });
        prune(messages, 1, 200);
        continue;
      }
      if (res.stop_reason === 'max_tokens' || res.stop_reason === 'model_context_window_exceeded') {
        const kept = res.content.filter((b) => b.type === 'compaction' || (b.type === 'text' && b.text.trim()));
        messages.push({ role: 'assistant', content: kept.some((b) => b.type === 'text') ? kept : [...kept, { type: 'text', text: '(cut off)' }] });
        messages.push({ role: 'user', content: 'Your last reply was cut off at the output limit before its tool calls were complete, so none of them ran. Be briefer and try again.' });
        continue;
      }
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const calls = res.content.filter((b) => b.type === 'tool_use');
      if (this.leadChat && !text && replyNudges < MAX_REPLY_NUDGES && !res.content.some((b) => b.type === 'compaction')) {
        // The user wrote in and the model acted without saying anything to them. That reply is
        // thrown away (its tool calls have not run) and the model is asked again, more firmly.
        replyNudges++;
        this.trace('lead', 'interrupt', { note: 'reply had no text for the user; asking again' });
        const last = messages.at(-1);
        if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
        last.content.push({ type: 'text', text: ANSWER_AGAIN });
        continue;
      }
      messages.push({ role: 'assistant', content: res.content });
      if (text) { lastText = text; this.emit({ type: 'step', agentId: 'lead', kind: 'say', text: clip(text, 2000), at: Date.now() }); }
      if (this.leadChat) {
        this.leadChat = false;
        replyNudges = 0;
        // Last resort if the model still said nothing: a factual status line built from what we know.
        const acted = calls.filter((c) => c.name !== 'wait' && c.name !== 'board_read').map((c) => c.name === 'spawn_agent' ? `starting "${c.input?.name}"`
          : c.name === 'message_agent' ? `redirecting "${c.input?.agent}"`
          : c.name === 'stop_agent' ? `stopping "${c.input?.agent}"` : c.name.replace('_', ' '));
        const status = this.agents.length
          ? this.agents.map((a) => `${a.name}: ${a.status === 'done' ? 'finished' : a.status === 'waiting' ? 'waiting on you' : a.status === 'blocked' ? a.label : a.status === 'error' ? `stopped (${a.label})` : a.status === 'cancelled' ? 'stopped' : `working${a.status === 'acting' && a.label ? ` (${a.label})` : ''}`}`).join('; ')
          : 'no workers started yet';
        this.emit({ type: 'chat', from: 'lead', name: 'Lead', text: text || `${acted.length ? `I am ${acted.join(', ')}. ` : ''}Status: ${status}.` });
      }

      if (calls.length === 0) {
        if (this.events.length) { messages.push({ role: 'user', content: `Updates:\n${this.drainEvents()}` }); continue; }
        // Workers still running: a reply with no tool call (often an answer to the user's chat) does not end
        // the job. The swarm waits for the next event on the lead's behalf, as if it had called wait.
        if (this.live().length && !nudged) {
          nudged = true;
          messages.push({ role: 'user', content: `${this.live().length} worker${this.live().length > 1 ? 's are' : ' is'} still running (${this.live().map((a) => a.name).join(', ')}). Call wait to keep supervising, or stop them, before you finish.` });
          continue;
        }
        if (this.live().length) {
          lead('waiting', `watching ${this.live().length} worker${this.live().length > 1 ? 's' : ''}`);
          await this.waitForEvents(signal);
          const news = this.drainEvents();
          messages.push({ role: 'user', content: `You replied without a tool call while workers are still running, so the swarm kept waiting for you. ${news ? `Updates:\n${news}` : 'Nothing new.'}\n\n${this.roster()}${this.live().length ? '\nCall wait to keep supervising, or stop_agent to end a worker.' : '\nNo workers are running.'}` });
          continue;
        }
        return lastText || 'Finished.';
      }

      // All spawns from one turn start together, so their windows can be tiled as a set.
      const spawns = calls.filter((c) => c.name === 'spawn_agent');
      const spawnResults = spawns.length ? this.spawnBatch(spawns.map((c) => c.input), signal) : [];
      const results = [];
      for (const call of calls) {
        if (signal.aborted) throw new Error('cancelled');
        const t0 = Date.now();
        let textOut;
        if (call.name === 'spawn_agent') {
          textOut = spawnResults[spawns.indexOf(call)];
        } else if (call.name === 'wait') {
          lead('waiting', this.live().length ? `watching ${this.live().length} worker${this.live().length > 1 ? 's' : ''}` : '');
          await this.waitForEvents(signal);
          const news = this.drainEvents();
          textOut = `${news || 'Nothing new.'}\n\n${this.roster()}${this.live().length ? '' : '\nNo workers are running.'}`;
        } else if (call.name === 'message_agent') {
          const a = this.find(call.input?.agent);
          if (!a) textOut = `No worker named "${call.input?.agent}". ${this.roster()}`;
          else if (!a.live) textOut = `"${a.name}" has already finished.`;
          else { a.inbox.push({ from: 'lead', text: String(call.input?.message ?? '') }); a.poke?.(); textOut = `Delivered to "${a.name}".`; }
        } else if (call.name === 'stop_agent') {
          const a = this.find(call.input?.agent);
          if (!a) textOut = `No worker named "${call.input?.agent}". ${this.roster()}`;
          else if (!a.live) textOut = `"${a.name}" has already finished.`;
          else { a.abort.abort(); textOut = `Stopping "${a.name}".`; }
        } else if (call.name === 'board_read') {
          textOut = this.board.length ? this.board.map((n) => `${n.from}: ${n.note}`).join('\n') : '(board is empty)';
        } else if (call.name === 'read_skill' || call.name === 'save_skill' || call.name === 'remember') {
          textOut = await this.skillTool(call);
        } else if (call.name === 'user_task') {
          lead('waiting', 'needs you');
          const reply = await this.requestHuman('lead', {
            kind: 'task',
            task: String(call.input?.task ?? ''),
            where: String(call.input?.where ?? ''),
            doneWhen: String(call.input?.done_when ?? ''),
            replyHint: String(call.input?.reply_hint ?? ''),
          }, signal);
          textOut = `The user replied: ${reply}`;
        } else if (call.name === 'ask_user') {
          lead('waiting', 'needs you');
          const reply = await this.requestHuman('lead', {
            kind: 'question',
            question: String(call.input?.question ?? ''),
            options: Array.isArray(call.input?.options) ? call.input.options.slice(0, 4).map(String) : [],
          }, signal);
          textOut = `The user answered: ${reply}`;
        } else {
          textOut = `Unknown tool ${call.name}`;
        }
        this.trace('lead', 'tool', { name: call.name, isError: false, result: String(textOut).slice(0, 1500) });
        this.emitStep('lead', call, textOut, false, t0);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: textOut }] });
      }
      messages.push({ role: 'user', content: results });
    }
    return lastText || 'Stopped at the turn limit before finishing.';
  }

  // Run one job end to end. Resolves when the swarm is idle again.
  // With resume.messages, the lead carries on a saved conversation (see snapshotMessages).
  // Afterwards this.leadSnapshot holds the conversation to save for the next resume.
  async run(goal, { resume = null } = {}) {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.agents = [];
    this.board = [];
    this.events = [];
    this.leadChat = false;
    this.grid = [];
    this.claims = new Map();
    this.usage = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.budgetWarned = false;
    this.leadCtx = null;
    this.leadSnapshot = null;
    let finished = false;
    try {
      await this.closeKept();
      this.emit({ type: 'reset' });
      this.emit({ type: 'state', state: 'planning' });
      if (this.learning) await Promise.race([this.learning, new Promise((r) => setTimeout(r, 3000))]);   // give the last retrospective a moment, never a long wait
      this.tracer = this.traceDir ? new Tracer(this.traceDir, goal) : null;
      if (!this.catalog) await this.loadCatalog();
      this.emit({ type: 'state', state: 'running' });
      const summary = await this.runLead(goal, signal, resume);
      this.trace('lead', 'end', { reason: 'reported', report: summary });
      this.trace('swarm', 'usage', { note: JSON.stringify(this.usage) });
      this.emit({ type: 'done', summary });
      this.lastJob = { goal, summary: String(summary).slice(0, 2000) };
      finished = true;
    } catch (err) {
      this.trace('lead', 'error', { message: signal.aborted ? 'cancelled by the user' : `${err?.status ? `HTTP ${err.status} ` : ''}${err?.message ?? err}` });
      this.emit({ type: 'error', message: signal.aborted ? 'Cancelled.' : String(err?.message ?? err) });
      const progress = this.agents.map((a) => `${a.name}: ${a.status}${a.label ? ` (${a.label})` : ''}`).join('; ');
      this.lastJob = { goal, summary: `${signal.aborted ? 'Stopped by the user before finishing.' : `Failed: ${err?.message ?? err}.`}${progress ? ` Workers then: ${progress}` : ''}`.slice(0, 2000) };
    } finally {
      // Saved before the retrospective adds its own turns to the same conversation.
      if (this.leadCtx) this.leadSnapshot = snapshotMessages(this.leadCtx.messages);
      // The lead is done or gone: stop whatever is still running and let it clean up.
      this.abort.abort();
      await Promise.all(this.agents.map((a) => a.promise));
      this.pending.clear();
      this.wake = null;
      this.running = false;
      this.emit({ type: 'lead', status: 'idle', label: '' });
      this.emit({ type: 'state', state: 'idle' });
      // Self-improvement: a finished job that used workers gets a retrospective.
      if (finished && this.skills && this.config.skills !== false && this.agents.length > 0 && this.leadCtx) {
        this.learning = this.learn(this.leadCtx).finally(() => { this.learning = null; });
      }
    }
  }

  cancel() {
    this.abort?.abort();
  }

  async closeKept() {
    const all = [...this.kept];
    this.kept.clear();
    await Promise.all(all.map((c) => Promise.resolve(c.close()).catch(() => {})));
  }

  async shutdown() {
    this.cancel();
    await this.closeKept();
    this.learnAbort?.abort();
    await Promise.all([...this.shared.values()].map((c) => c.close()));
    this.shared.clear();
  }
}
