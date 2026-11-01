import { createHash } from 'node:crypto';

export interface ToolNameRules {
  maxLength: number;
  /** Characters not allowed in a name. Must use the g flag. */
  invalid: RegExp;
  /** Name must start with a letter or underscore (Gemini). */
  letterStart?: boolean;
}

/** OpenAI, Anthropic: ^[a-zA-Z0-9_-]{1,64}$ */
export const DEFAULT_TOOL_NAME_RULES: ToolNameRules = { maxLength: 64, invalid: /[^a-zA-Z0-9_-]/g };
/** Gemini: starts with a letter or underscore, then letters, digits, _ . : - up to 64. */
export const GEMINI_TOOL_NAME_RULES: ToolNameRules = { maxLength: 64, invalid: /[^a-zA-Z0-9_.:-]/g, letterStart: true };

function hash8(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8);
}

/**
 * Deterministic wire name for a tool. Valid names pass through unchanged.
 * Invalid or long names keep a readable prefix plus a hash of the original,
 * so the same tool always gets the same wire name across requests.
 */
export function wireToolName(name: string, rules: ToolNameRules = DEFAULT_TOOL_NAME_RULES): string {
  let clean = name.replace(rules.invalid, '_');
  if (rules.letterStart && !/^[a-zA-Z_]/.test(clean)) clean = `_${clean}`;
  if (clean === name && name.length > 0 && name.length <= rules.maxLength) return name;
  const suffix = `_${hash8(name)}`;
  return clean.slice(0, rules.maxLength - suffix.length) + suffix;
}

/** Maps tool names to wire names for one request and back for the response. */
export class ToolNameMap {
  private toWire = new Map<string, string>();
  private fromWire = new Map<string, string>();

  constructor(private rules: ToolNameRules = DEFAULT_TOOL_NAME_RULES) {}

  wire(name: string): string {
    let w = this.toWire.get(name);
    if (!w) {
      w = wireToolName(name, this.rules);
      this.toWire.set(name, w);
      this.fromWire.set(w, name);
    }
    return w;
  }

  /** Original name for a wire name. Unknown names pass through. */
  original(wire: string): string {
    return this.fromWire.get(wire) ?? wire;
  }
}
