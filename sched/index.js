// sched/: limit(n) -> (fn) => Promise. At most n of the wrapped calls run at once; the rest queue in order.

export function limit(n) {
  if (!(n >= 1)) throw new Error('limit(n) needs n >= 1');
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  const run = (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  Object.defineProperties(run, {
    active: { get: () => active },
    pending: { get: () => queue.length },
  });
  return run;
}

/** Wraps an llm ({ create }) so at most n create() calls are in flight. A call aborted while queued never starts. */
export function limitLlm(llm, n) {
  const run = limit(n);
  return {
    create: (params, opts = {}) => run(() => {
      if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return llm.create(params, opts);
    }),
  };
}
