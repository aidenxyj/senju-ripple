// Skills & memory, shared by the launcher and the web page.
//
//   renderLibrary(container, api, { team, tab })
//   api: { skills(), saveSkill({name, description, body}), deleteSkill(name), notes(), addNote(note, scope), deleteNote(id) }
//   Every api function returns a promise and throws an Error with a readable message.
import { h } from './brand.js';

export function renderLibrary(root, api, { team = false, tab = 'skills' } = {}) {
  const state = { tab, editing: null };
  const body = h('div', { class: 'lib-body' });
  const tabs = h('div', { class: 'lib-tabs' });
  const intro = h('p', { class: 'lib-intro dim' });
  root.replaceChildren(h('header', { class: 'lib-head drag' }, h('h2', { class: 'display lib-title' }, 'Skills & memory'), h('div', { class: 'nodrag' }, tabs)), intro, body);

  const fail = (err) => body.replaceChildren(h('p', { class: 'error-text' }, err.message));

  function show() {
    tabs.replaceChildren(...['skills', 'notes'].map((t) => h('button', { class: `tv-filter${state.tab === t ? ' on' : ''}`, onclick: () => { state.tab = t; state.editing = null; show(); } }, t === 'skills' ? 'Skills' : 'Memory')));
    intro.textContent = state.tab === 'skills'
      ? `How-tos the lead writes after a job and reads before the next. ${team ? 'Shared with your team; every save is kept as a revision.' : 'Stored as files on this Mac.'}`
      : `What the lead should always know. ${team ? 'Notes about you are yours alone; team notes everyone in the team sees.' : 'Stays on this Mac.'}`;
    body.replaceChildren(h('p', { class: 'dim' }, 'Loading…'));
    (state.tab === 'skills' ? skills() : notes()).catch(fail);
  }

  async function skills() {
    const all = await api.skills();
    const list = h('div', { class: 'skill-list' },
      h('button', { class: 'btn btn-punk btn-sm', onclick: () => { state.editing = { name: '', description: '', body: '', isNew: true }; skills().catch(fail); } }, '+ New skill'),
      all.length ? null : h('p', { class: 'dim' }, 'No skills yet. They appear after the first jobs.'),
      all.map((k) => h('button', { class: `skill-item${state.editing?.name === k.name ? ' on' : ''}`, onclick: () => { state.editing = { ...k }; skills().catch(fail); } },
        h('b', {}, k.name), h('span', {}, k.description), h('small', {}, `revision ${k.revision ?? 1}${k.authorName ? ` · ${k.authorName}` : ''}`))));
    let editor;
    if (state.editing) {
      const e = state.editing;
      const name = h('input', { class: 'field', value: e.name, placeholder: 'kebab-case-name', disabled: !e.isNew });
      const desc = h('input', { class: 'field', value: e.description ?? '', placeholder: 'One sentence: when should a job use this?' });
      const text = h('textarea', { class: 'field mono', rows: 16, placeholder: 'Instructions to a future agent: the plan shape, what worked on each site, pitfalls, what needs you.' });
      text.value = e.body ?? '';
      const err = h('p', { class: 'error-text' });
      editor = h('div', { class: 'skill-editor' },
        h('label', {}, 'Name'), name, h('label', {}, 'When to use it'), desc, h('label', {}, 'Instructions'), text, err,
        h('div', { class: 'row' },
          e.isNew ? null : h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
            if (!confirm(`Delete the skill "${e.name}"?`)) return;
            try { await api.deleteSkill(e.name); state.editing = null; await skills(); } catch (x) { err.textContent = x.message; }
          } }, 'Delete'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => { state.editing = null; skills().catch(fail); } }, 'Cancel'),
          h('button', { class: 'btn btn-punk btn-sm', onclick: async () => {
            try {
              const saved = await api.saveSkill({ name: name.value, description: desc.value, body: text.value });
              state.editing = { ...e, ...saved, body: text.value, description: desc.value, isNew: false };
              await skills();
            } catch (x) { err.textContent = x.message; }
          } }, 'Save')));
    } else editor = h('div', { class: 'skill-editor empty' }, h('p', { class: 'dim' }, 'Pick a skill to read or edit it.'));
    body.replaceChildren(h('div', { class: 'skills' }, list, editor));
  }

  async function notes() {
    const all = await api.notes();
    const input = h('input', { class: 'field', placeholder: team ? 'Something the lead should know, e.g. “I write in British English.”' : 'Something the lead should know, e.g. “Use Safari, not Chrome.”' });
    const scope = team ? h('select', { class: 'field scope' }, h('option', { value: 'me' }, 'About me'), h('option', { value: 'team' }, 'For the team')) : null;
    const err = h('p', { class: 'error-text' });
    const addIt = async () => { try { await api.addNote(input.value, scope?.value ?? 'me'); await notes(); } catch (x) { err.textContent = x.message; } };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addIt(); });
    body.replaceChildren(
      h('div', { class: 'note-add' }, input, scope, h('button', { class: 'btn btn-punk btn-sm', onclick: addIt }, 'Remember')), err,
      h('div', { class: 'notes' }, all.length ? all.map((n) => h('div', { class: 'note' },
        h('span', { class: `pill ${n.scope === 'team' ? 'live' : ''}` }, n.scope === 'team' ? 'team' : team ? 'you' : 'note'),
        h('p', {}, n.note),
        h('small', { class: 'dim' }, n.authorName ? `from ${n.authorName}` : ''),
        h('button', { class: 'link', onclick: async () => { try { await api.deleteNote(n.id); await notes(); } catch (x) { err.textContent = x.message; } } }, 'Forget'))) : h('p', { class: 'dim' }, 'Nothing remembered yet.')));
  }

  show();
}
