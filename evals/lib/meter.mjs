// Wraps a model client and counts what the eval rows report: model calls (steps), tokens,
// and invalid tool calls (unknown tool, arguments that did not parse, or arguments that break the schema).

export function meter(llm) {
  const stats = { steps: 0, tokens: 0, invalidCalls: 0, invalid: [] };
  return {
    stats,
    llm: {
      async create(params, opts) {
        const res = await llm.create(params, opts);
        stats.steps += 1;
        stats.tokens += (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0);
        const tools = new Map((params.tools ?? []).map((t) => [t.name, t]));
        for (const block of res.content ?? []) {
          if (block.type !== 'tool_use') continue;
          const why = invalidReason(block, tools);
          if (why) { stats.invalidCalls += 1; stats.invalid.push(`${block.name}: ${why}`); }
        }
        return res;
      },
    },
  };
}

export function invalidReason(block, tools) {
  const tool = tools.get(block.name);
  if (!tool) return 'unknown tool';
  const input = block.input;
  if (input && typeof input === 'object' && '_raw' in input) return 'arguments are not valid JSON';
  return schemaError(input, tool.input_schema);
}

// A light check of the top level of an object schema: it must be an object, have the required keys,
// and give each declared key a value of the declared JSON type. Enough to catch what models get wrong.
export function schemaError(input, schema) {
  if (!schema || schema.type !== 'object') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'arguments are not an object';
  for (const key of schema.required ?? []) if (!(key in input)) return `missing "${key}"`;
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (!(key in input) || !prop?.type) continue;
    const types = [].concat(prop.type);
    if (!types.some((t) => isType(input[key], t))) return `"${key}" should be ${types.join(' or ')}`;
  }
  return null;
}

function isType(v, t) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}
