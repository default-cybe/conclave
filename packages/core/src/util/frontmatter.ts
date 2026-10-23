import YAML from 'yaml';

/** Split a markdown file into YAML frontmatter and body. */
export function parseFrontmatter<T = Record<string, unknown>>(text: string): { data: T; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {} as T, body: text };
  let data: T;
  try {
    data = (YAML.parse(m[1]) ?? {}) as T;
  } catch {
    data = {} as T;
  }
  return { data, body: m[2] };
}

/** A one-line text field that YAML may have read as a list: `argument-hint: [message]` stays "[message]". */
export function textField(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = (Array.isArray(v) ? `[${v.map(String).join(', ')}]` : String(v)).trim();
  return s.length ? s : undefined;
}

export function toFrontmatter(data: Record<string, unknown>, body: string): string {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  return `---\n${YAML.stringify(clean).trimEnd()}\n---\n\n${body.trim()}\n`;
}

/** Accept "a, b, c" or ["a","b"]. */
export function toList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
