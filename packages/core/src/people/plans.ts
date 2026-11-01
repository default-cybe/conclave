/**
 * A member's own signed in plans (docs/design/ACCOUNTS.md 12). Each member
 * who signs in a Claude, ChatGPT or other plan gets their own CLIProxyAPI,
 * which the server runs (server/src/cliproxy/member.ts). Core only knows
 * what this interface says: where that CLIProxyAPI answers, its client key
 * and the models it lists.
 *
 * A member's calls through the provider `cliproxy` go to their own
 * CLIProxyAPI when one of their plans lists the model, and to the hub's
 * only while the owner lets them use it (people/access.ts). The owner's
 * calls never reach a member's: the owner's registry has no overlay.
 */
import type { ProviderConfig } from '../config/schema';
import type { ChatRequest, ModelInfo, Provider, StreamEvent } from '../providers/types';
import { ProviderError } from '../providers/types';
import type { AccountDto } from '../client/accounts';

/** The provider id signed in plans go by: the hub's and a member's own. */
export const PLAN_PROVIDER = 'cliproxy';

/** A member's own CLIProxyAPI as a provider entry. The key never leaves the hub. */
export interface MemberPlanEntry {
  /** Its address (loopback), wires and models: the same shape as the hub's providers.cliproxy. */
  config: ProviderConfig;
  /** The client key of that CLIProxyAPI. */
  apiKey: string;
}

/** What the server tells core about members' own plans. */
export interface MemberPlans {
  /** The entry for the member's own CLIProxyAPI while it answers, else undefined. */
  entry(accountId: string): MemberPlanEntry | undefined;
  /** How many plans the member has signed in (0 when none, or before it was read). */
  count(accountId: string): number;
  /** fn(accountId) after a member's entry changed: started, stopped, other models. Returns the unsubscribe. */
  onChange(fn: (accountId: string) => void): () => void;
  /** A call on a member's own plan was refused for a limit: read their plans again soon. */
  noteLimit?(accountId: string): void;
  /** The member's own plans that can take this model now, in their order (AccountsService.readyAccounts of their own CLIProxyAPI); [] when none runs. */
  readyAccounts?(accountId: string, model: string): AccountDto[];
}

/** True when the member's own CLIProxyAPI lists this model (bare, or with a plan's short name). */
export function entryServes(entry: MemberPlanEntry | undefined, model: string): boolean {
  return !!entry && !!model && !!entry.config.models?.includes(model);
}

/**
 * The `cliproxy` provider in a member's registry. A model one of their own
 * plans lists goes to their own CLIProxyAPI; any other goes to the hub's,
 * and only while the owner allows it (checked on every call, so a grant
 * taken back stops the next call). Each side keeps its own address and key.
 */
export class MemberPlanProvider implements Provider {
  readonly type = 'openai' as const;

  constructor(
    readonly id: string,
    private readonly own: Provider,
    private readonly hub: Provider | undefined,
    private readonly opts: {
      /** One of the member's own plans lists this model now. */
      serves: (model: string) => boolean;
      /** The owner lets this member use the hub's plans now. */
      hubAllowed: () => boolean;
      /** What a refused call says. */
      refusal: () => string;
    },
  ) {}

  /** Which side takes this model, or undefined when neither may. */
  private side(model: string): Provider | undefined {
    if (this.opts.serves(model)) return this.own;
    return this.hub && this.opts.hubAllowed() ? this.hub : undefined;
  }

  stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const p = this.side(req.model);
    if (!p) throw new ProviderError('auth', this.opts.refusal(), { provider: this.id, code: 'access' });
    return p.stream(req);
  }

  model(id: string): ModelInfo {
    return (this.opts.serves(id) || !this.hub ? this.own : this.hub).model(id);
  }

  /** The member's own models first, then the hub's they may use. */
  async listModels(): Promise<ModelInfo[]> {
    const own = await this.own.listModels();
    if (!this.hub || !this.opts.hubAllowed()) return own;
    const seen = new Set(own.map((m) => m.id));
    const hub = await this.hub.listModels().catch(() => [] as ModelInfo[]);
    return [...own, ...hub.filter((m) => !seen.has(m.id))];
  }

  countTokens(req: ChatRequest): Promise<number> {
    const p = this.side(req.model);
    if (!p?.countTokens) return Promise.reject(new Error('token counting is not available for this model'));
    return p.countTokens(req);
  }
}

/**
 * The member's `cliproxy` entry: their own CLIProxyAPI, listing their own
 * models first and then the hub's ones they may use, so pickers and refs
 * resolve both. Calls still pick a side per model (MemberPlanProvider).
 */
export function memberPlanConfig(entry: MemberPlanEntry, hub: ProviderConfig | undefined, hubAllowed: boolean): ProviderConfig {
  const own = entry.config.models ?? [];
  const extra = hubAllowed && hub ? (hub.models ?? []).filter((m) => !own.includes(m)) : [];
  return { ...entry.config, ...(hub?.name ? { name: hub.name } : {}), models: [...own, ...extra], enabled: true };
}
