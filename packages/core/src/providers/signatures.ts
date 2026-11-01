/**
 * ThinkingBlock.signature is opaque and only valid for the model that wrote
 * it. Anthropic signatures are stored raw (the Anthropic API itself drops
 * blocks a model cannot read). Other providers' reasoning state is tagged
 * with its kind and model so each provider can tell whether a block is its
 * own and still valid:
 *
 *   cv1|<kind>|<encoded model>|<payload>
 */

export type SignatureKind = 'openai-responses' | 'openai-chat' | 'gemini';

const PREFIX = 'cv1|';

export interface TaggedSignature {
  kind: SignatureKind;
  model: string;
  payload: string;
}

export function tagSignature(kind: SignatureKind, model: string, payload = ''): string {
  return `${PREFIX}${kind}|${encodeURIComponent(model)}|${payload}`;
}

/** Parse a tagged signature. Returns undefined for raw (Anthropic) or missing signatures. */
export function readSignature(sig: string | undefined): TaggedSignature | undefined {
  if (!sig || !sig.startsWith(PREFIX)) return undefined;
  const rest = sig.slice(PREFIX.length);
  const a = rest.indexOf('|');
  const b = a < 0 ? -1 : rest.indexOf('|', a + 1);
  if (a < 0 || b < 0) return undefined;
  return {
    kind: rest.slice(0, a) as SignatureKind,
    model: decodeURIComponent(rest.slice(a + 1, b)),
    payload: rest.slice(b + 1),
  };
}

export function isTaggedSignature(sig: string | undefined): boolean {
  return !!sig && sig.startsWith(PREFIX);
}

/** Signature belongs to this kind and model. */
export function ownSignature(sig: string | undefined, kind: SignatureKind, model: string): TaggedSignature | undefined {
  const t = readSignature(sig);
  if (!t || t.kind !== kind) return undefined;
  return sameModel(t.model, model) ? t : undefined;
}

export function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/^models\//, '');
  return norm(a) === norm(b);
}
