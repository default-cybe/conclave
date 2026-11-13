/**
 * One image call for a session's account (docs/design/IMAGE-GENERATION.md):
 * pick the model (the call's, else Settings > Models "Image model", else
 * cliproxy/gpt-image-2.5), send it through the account's own provider
 * registry, and write one usage row with purpose 'image'.
 *
 * A member's call goes only to their own plans or keys, never the owner's:
 * a grant to the hub's providers covers chat, not the owner's image quota.
 */
import { imagePriceUsd } from '../providers/catalog';
import { IMAGE_MODEL, parseModelRef, type ImageRequest, type ImageResult, type Provider } from '../providers/types';
import type { ConclaveConfig } from '../config/schema';
import type { UsageInput } from '../usage/readers/common';
import { isMember } from '../people/context';

export const DEFAULT_IMAGE_MODEL = 'cliproxy/gpt-image-2.5';

/** The slice of the engine an image call uses, so tests can fake it. */
export interface ImageDeps {
  config: { get(): Pick<ConclaveConfig, 'imageModel' | 'providers'> };
  providersFor(accountId: string | undefined): { get(providerId: string): Provider | undefined };
  access: { source(accountId: string, provider: string, model?: string): 'hub' | 'own' | 'none' };
  usage: { record(r: UsageInput): unknown };
}

export interface ImageCall extends Omit<ImageRequest, 'model'> {
  /** "provider/model"; default the Image model setting. */
  model?: string;
  accountId: string;
  sessionId?: string;
}

export interface ImageOutcome extends ImageResult {
  ref: string;
  latencyMs: number;
}

/** Errors the tool shows word for word. */
export class ImageRefusal extends Error {}

export function imageModelOf(cfg: Pick<ConclaveConfig, 'imageModel'>, asked?: string): string {
  return asked?.trim() || cfg.imageModel || DEFAULT_IMAGE_MODEL;
}

export async function generateImageFor(deps: ImageDeps, call: ImageCall): Promise<ImageOutcome> {
  const cfg = deps.config.get();
  const ref = imageModelOf(cfg, call.model);
  const { provider: pid, model } = parseModelRef(ref);
  if (!pid || !model) throw new ImageRefusal(`"${ref}" is not a provider/model reference.`);
  if (!IMAGE_MODEL.test(model)) throw new ImageRefusal(`${ref} is not an image model. Pick one in Settings > AI connections > Defaults, Image model.`);
  const member = isMember(call.accountId);
  if (member && deps.access.source(call.accountId, pid, model) !== 'own') {
    throw new ImageRefusal(`You have no plan or API key of your own for ${ref}. Images are made only on your own plans or keys, never the hub owner's. Sign in a ChatGPT plan in Settings > AI connections > Subscriptions or add your own key for ${pid}.`);
  }
  const provider = deps.providersFor(call.accountId).get(pid);
  if (!provider) throw new ImageRefusal(`Provider "${pid}" is not set up. Add it in Settings > Providers.`);
  if (!provider.generateImage) throw new ImageRefusal(`Provider "${pid}" cannot make images. Pick an OpenAI-compatible image model in Settings > AI connections > Defaults, Image model.`);
  const started = Date.now();
  const { accountId, sessionId, model: _m, ...req } = call;
  const result = await provider.generateImage({ ...req, model });
  const latencyMs = Date.now() - started;
  // a signed in plan (or a member's own CLIProxyAPI) bills nothing per image; the row keeps the API list price as its value
  const plan = !!cfg.providers[pid]?.subscription || (member && pid === 'cliproxy');
  const value = imagePriceUsd(req.quality ?? 'medium', req.size ?? '1024x1024', result.images.length);
  const u = result.usage;
  deps.usage.record({
    ...(sessionId ? { sessionId } : {}),
    source: 'tool',
    provider: pid,
    model,
    inputTokens: u?.inputTokens ?? 0,
    outputTokens: u?.outputTokens ?? 0,
    cacheReadTokens: u?.cacheReadTokens ?? 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: plan ? 0 : value,
    apiValueUsd: value,
    latencyMs,
    purpose: 'image',
    accountId,
    ...(member ? { paidBy: 'own' as const } : {}),
  });
  return { ...result, ref, latencyMs };
}
