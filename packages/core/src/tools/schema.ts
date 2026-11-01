/**
 * A small recursive JSON Schema validator for structured output (workflow
 * agent() calls with a schema, Task with a schema). It covers the keywords
 * models are asked to satisfy: type, required, properties, items, enum,
 * const, pattern, minItems, maxItems, minLength, maxLength, minimum, maximum,
 * additionalProperties, anyOf and oneOf. Problems come back by path, so a bad
 * StructuredOutput call can list each one
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.6).
 */

export type Schema = Record<string, unknown>;

export interface SchemaProblem {
  /** "$" for the root, "$.findings[2].line" below it. */
  path: string;
  message: string;
}

const MAX_PROBLEMS = 20;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const got = typeOf(v);
  if (want === got) return true;
  if (want === 'number' && got === 'integer') return true;
  return false;
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s && s.length > 60 ? `${s.slice(0, 57)}...` : String(s);
}

/** Longest string a risky pattern runs on (2^20 steps at worst). */
const RISKY_PATTERN_MAX = 20;

/**
 * Whether a pattern repeats a group that has a quantifier inside, such as
 * (a+)+ or (\w*\s?)*: on a short string that almost matches, the regex
 * engine can backtrack for minutes. Schemas come from models (Task, workflow
 * scripts), so such a pattern only checks short strings.
 */
export function riskyPattern(p: string): boolean {
  const stack: boolean[] = [];
  let inner = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') {
      for (i++; i < p.length && p[i] !== ']'; i++) if (p[i] === '\\') i++;
      continue;
    }
    if (c === '(') {
      stack.push(inner);
      inner = false;
      continue;
    }
    if (c === ')') {
      const had: boolean = inner;
      inner = (stack.pop() ?? false) || had;
      const next = p[i + 1];
      if (had && (next === '*' || next === '+' || next === '{')) return true;
      continue;
    }
    if (c === '*' || c === '+' || c === '{') inner = true;
  }
  return false;
}

function walk(schema: Schema, v: unknown, path: string, out: SchemaProblem[]): void {
  if (out.length >= MAX_PROBLEMS || !schema || typeof schema !== 'object') return;
  const push = (message: string) => {
    if (out.length < MAX_PROBLEMS) out.push({ path, message });
  };

  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const options = (schema.anyOf ?? schema.oneOf) as Schema[];
    const passing = options.filter((o) => validateSchema(o, v).length === 0).length;
    if (Array.isArray(schema.anyOf) && passing === 0) return push('matches none of the allowed shapes');
    if (Array.isArray(schema.oneOf) && passing !== 1) return push(passing ? 'matches more than one allowed shape' : 'matches none of the allowed shapes');
  }

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((t) => typeMatches(t, v))) return push(`must be ${types.join(' or ')}, got ${typeOf(v)}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) push(`must be ${short(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) push(`must be one of: ${schema.enum.map(short).join(', ')}`);

  if (typeof v === 'string') {
    if (typeof schema.minLength === 'number' && v.length < schema.minLength) push(`must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && v.length > schema.maxLength) push(`must be at most ${schema.maxLength} characters`);
    // a pattern with a repeated group that repeats inside ((a+)+) can take exponential time and stall the hub: only short strings get it
    if (typeof schema.pattern === 'string' && (v.length <= RISKY_PATTERN_MAX || !riskyPattern(schema.pattern))) {
      try {
        if (!new RegExp(schema.pattern, 'u').test(v)) push(`must match /${schema.pattern}/`);
      } catch {
        // a pattern the engine cannot compile checks nothing
      }
    }
  }
  if (typeof v === 'number') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) push(`must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && v > schema.maximum) push(`must be <= ${schema.maximum}`);
  }
  if (Array.isArray(v)) {
    if (typeof schema.minItems === 'number' && v.length < schema.minItems) push(`must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) push(`must have at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      v.forEach((item, i) => walk(schema.items as Schema, item, `${path}[${i}]`, out));
    }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>;
    const props = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, Schema>;
    for (const key of (Array.isArray(schema.required) ? schema.required : []) as string[]) {
      if (obj[key] === undefined) {
        if (out.length < MAX_PROBLEMS) out.push({ path: `${path}.${key}`, message: 'is required' });
      }
    }
    for (const [key, val] of Object.entries(obj)) {
      if (props[key]) walk(props[key], val, `${path}.${key}`, out);
      else if (schema.additionalProperties === false) {
        if (out.length < MAX_PROBLEMS) out.push({ path: `${path}.${key}`, message: 'is not allowed' });
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        walk(schema.additionalProperties as Schema, val, `${path}.${key}`, out);
      }
    }
  }
}

/** Every problem with a value against a schema, by path. Empty means valid. */
export function validateSchema(schema: Schema, value: unknown): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  walk(schema, value, '$', out);
  return out;
}

/** The problems as lines a model can act on. */
export function formatProblems(problems: SchemaProblem[]): string {
  return problems.map((p) => `- ${p.path} ${p.message}`).join('\n');
}

/**
 * Check that a schema can be used for structured output: the root is
 * { type: 'object' } and required names only properties it defines. Throws
 * with the reason otherwise (Claude Code's rule: an unsatisfiable schema
 * throws at agent()).
 */
export function assertOutputSchema(schema: unknown): asserts schema is Schema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('schema must be an object');
  const s = schema as Schema;
  if (s.type !== 'object') throw new Error("schema root must be { type: 'object' }");
  const props = s.properties;
  if (props !== undefined && (typeof props !== 'object' || props === null || Array.isArray(props))) throw new Error('schema properties must be an object');
  const required = s.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((r) => typeof r !== 'string')) throw new Error('schema required must be a list of property names');
    const missing = (required as string[]).filter((r) => !props || !(r in (props as object)));
    if (missing.length) throw new Error(`schema required names properties it does not define: ${missing.join(', ')}`);
  }
}
