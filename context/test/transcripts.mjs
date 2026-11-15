// Synthetic worker transcripts in the swarm engine's message shape, seeded so every run is the same.

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const WORDS = 'button link textbox heading row cell menu item search submit cancel price total cart checkout name email next previous page results filter sort'.split(' ');

/** A page dump like `senju look` prints: `ok` then one element per line. */
export function pageDump(rand, chars) {
  const lines = ['ok', `page: https://shop.test/p/${Math.floor(rand() * 1000)}`];
  let n = 0, len = 0;
  while (len < chars) {
    const line = `e${n++} ${WORDS[Math.floor(rand() * WORDS.length)]} "${WORDS[Math.floor(rand() * WORDS.length)]} ${Math.floor(rand() * 9999)}"`;
    lines.push(line);
    len += line.length + 1;
  }
  return lines.join('\n');
}

export const SYSTEM = `You are a worker in a swarm. Your subtask: compare prices for three items and write them to prices.txt.\n${'Rules: act through the sh tool only. One senju command per line. Report with senju done. '.repeat(40)}`;

/**
 * steps: number of tool calls. obsChars: typical observation size.
 * Mixes: string and block tool_result content, errors, two calls in one turn,
 * inbox text appended to a tool_result message, an image, a cut-off reply.
 */
export function workerTranscript({ steps = 40, obsChars = 6000, seed = 7, endWith = 'tool_result' } = {}) {
  const rand = rng(seed);
  const messages = [{ role: 'user', content: 'Begin your subtask now.' }];
  let id = 0;
  for (let s = 0; s < steps; s++) {
    if (s > 0 && s % 17 === 0) {
      // A reply cut off at the output limit, as the orchestrator records it.
      messages.push({ role: 'assistant', content: [{ type: 'text', text: '(cut off)' }] });
      messages.push({ role: 'user', content: 'Your last reply hit the output limit and was cut off before its tool call was complete, so nothing was done. Carry on.' });
    }
    const two = s % 9 === 4;
    const calls = (two ? [0, 1] : [0]).map(() => ({ type: 'tool_use', id: `toolu_${String(++id).padStart(4, '0')}`, name: 'sh', input: { cmd: rand() < 0.5 ? 'senju look' : `senju click e${Math.floor(rand() * 40)}` } }));
    const content = [];
    if (rand() < 0.6) content.push({ type: 'text', text: `Step ${s}: checking the page for the next price.` });
    content.push(...calls);
    messages.push({ role: 'assistant', content });
    const results = calls.map((c, j) => {
      const size = Math.floor(obsChars * (0.4 + rand()));
      const err = s % 11 === 3;
      const text = err ? `error: no element e${s}\nTry senju look first.` : pageDump(rand, size);
      if (s % 13 === 5 && j === 0) return { type: 'tool_result', tool_use_id: c.id, content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] };
      if (s % 5 === 2) return { type: 'tool_result', tool_use_id: c.id, content: text, is_error: err };
      return { type: 'tool_result', tool_use_id: c.id, content: [{ type: 'text', text }], is_error: err };
    });
    const user = { role: 'user', content: results };
    if (s % 7 === 6) user.content = [...results, { type: 'text', text: `Message from the lead: the second item is now "blue kettle ${s}".` }];
    messages.push(user);
  }
  if (endWith === 'assistant') messages.push({ role: 'assistant', content: [{ type: 'text', text: 'All three prices are saved.' }] });
  if (endWith === 'user') {
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Two of three prices found.' }] });
    messages.push({ role: 'user', content: 'Message from the user: also check shipping costs.' });
  }
  return messages;
}
