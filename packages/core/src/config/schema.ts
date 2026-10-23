import type { PermissionMode, JuryConfig, RemoteMode } from '../types';
import type { BrowserProxyConfig } from '../browser/proxy-provider';

/**
 * Provider wire types.
 * anthropic : Anthropic Messages API (also CLIProxyAPI /v1/messages, MiniMax...)
 * openai    : OpenAI Chat Completions compatible (OpenAI, z.ai /api/coding/paas/v4 (the zai default), OpenRouter, DeepSeek, Groq, Ollama, LM Studio, CLIProxyAPI)
 * gemini    : Google Generative Language API
 * acp       : an external agent harness spoken to over the Agent Client Protocol (Claude Code, Codex, Gemini CLI, OpenCode...)
 */
export type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'acp';

export interface ProviderConfig {
  type: ProviderType;
  /** Display name. */
  name?: string;
  baseUrl?: string;
  /** Literal key. Prefer apiKeyEnv or the secrets store. */
  apiKey?: string;
  /** Environment variable holding the key. */
  apiKeyEnv?: string;
  /** How the key is sent. Inferred from the key shape when omitted. */
  authType?: 'x-api-key' | 'bearer';
  headers?: Record<string, string>;
  /** Models to show in pickers. When empty the provider's catalog or /models endpoint is used. */
  models?: string[];
  /** Per-model overrides (context window, pricing, capabilities). */
  modelOverrides?: Record<string, Partial<ModelOverride>>;
  /**
   * What a plan says about its own models (the hub's CLIProxyAPI manager fills
   * it from a ChatGPT plan's Codex model list; runtime only): the name it
   * shows, the Effort levels it takes and its default, keyed by bare model id.
   */
  modelMeta?: Record<string, { name?: string; efforts?: string[]; defaultEffort?: string }>;
  enabled?: boolean;
  /** Subscription id this provider bills against, used to group limits (e.g. "zai-coding"). */
  subscription?: string;
  /** For type "acp": the command that starts the agent in ACP mode. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** For type "openai": use the Responses API instead of Chat Completions. */
  responsesApi?: boolean;
  /**
   * For type "openai" on a gateway that also speaks the Anthropic Messages
   * wire (CLIProxyAPI): models whose id matches one of `models` ("claude-*",
   * "*\/claude-*") go to `baseUrl` + /v1/messages with the same key. Every
   * model no wire claims (geminiWire, responsesWire) uses Chat Completions
   * at the provider's own baseUrl.
   */
  anthropicWire?: { baseUrl: string; models: string[] };
  /**
   * For a provider whose own wire is not Anthropic but that also has an
   * Anthropic Messages upstream (Z.ai's /api/anthropic): the model gateway
   * sends Anthropic-format requests (/gw/anthropic, /gw/p/<id>/v1/messages)
   * there with the same key. Sessions never use it.
   */
  anthropicBaseUrl?: string;
  /** providers.zai only: "paas-v4" once the load-time move off the Anthropic shim ran or the entry was set after it (config/retired.ts). */
  migrated?: string;
  /**
   * For type "openai" on a gateway (CLIProxyAPI): models whose id matches one
   * of `models` ("gpt-*") take the Responses wire at the provider's baseUrl.
   */
  responsesWire?: { models: string[] };
  /**
   * For type "openai" on a gateway that also speaks the native Gemini wire
   * (CLIProxyAPI): models whose id matches one of `models` ("gemini-*") go to
   * `baseUrl` + /v1beta/models/... with the same key. anthropicWire wins first.
   */
  geminiWire?: { baseUrl: string; models: string[] };
  /**
   * Header that carries the session id on every request (CLIProxyAPI reads
   * X-Session-ID to keep one conversation on one account).
   */
  sessionHeader?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

/**
 * A money budget for an API account (docs/research/2026-10-20-next-features.md 1).
 * Spend comes from Conclave's own cost records for that account.
 */
export interface AccountBudget {
  usd: number;
  /** month (default), week or day. */
  period?: 'month' | 'week' | 'day';
  /** month: day of the month it resets (1 to 31, default 1; past a short month's end it resets on its last day). week: 0 Sunday to 6 Saturday (default 1). */
  resetDay?: number;
  /** Hour it resets, 0 to 23 (default 0). */
  resetHour?: number;
  /** IANA time zone of the reset (default the hub's). */
  tz?: string;
  /** Percent of the budget at which the owner is told once per period. Default 80. */
  warnAt?: number;
  /** At 100% calls on this account stop until the reset. Default true. */
  hardStop?: boolean;
}

/**
 * The window starter of a signed in plan (core/src/accounts/starter.ts,
 * after the Lamplighter plugin for CLIProxyAPI): right after its 5 hour
 * window resets, one tiny request starts the next window.
 */
export interface AccountStarter {
  /** Default false. */
  enabled?: boolean;
  /** The model it asks. Default: the plan's cheapest (the newest Haiku, the smallest GPT, Flash). */
  model?: string;
  /** "07:00" (default): no request before this time of day. */
  start?: string;
  /** "22:30" (default): no request after it. A reset later than this waits for the start the next day. */
  end?: string;
  /** IANA time zone of the hours. Default: the owner's (Settings > Assistant), else the hub's. */
  tz?: string;
}

/** One account the hub may use for a vendor's models: a signed in plan or an API key. */
export interface AccountConfig {
  /** Stable id, kept on usage rows. */
  id: string;
  /** "Account 1". Default: the email, or the provider's name. */
  label?: string;
  /** Model family: anthropic, openai, gemini... */
  vendor: string;
  kind: 'subscription' | 'api';
  /** subscription: the CLIProxyAPI credential name. */
  credential?: string;
  /** api: the provider id that holds the key (anthropic). */
  provider?: string;
  /** false pauses it. Default true. */
  enabled?: boolean;
  budget?: AccountBudget;
  /** subscription: start the next 5 hour window right after a reset. Off by default. */
  starter?: AccountStarter;
  /**
   * "Use when a model refuses": after a refusal the same messages go to the
   * same model on each such plan or key of the model's vendor, in this order,
   * before the Refusal fallback list (session/refusal-fallback.ts). Off by default.
   */
  refusal?: boolean;
}

/** The owner's order of accounts for a vendor, or for the models a match picks. */
export interface AccountRoute {
  vendor: string;
  /** "claude-opus-*" or an exact id. Without it the order is the vendor's default. */
  match?: string;
  /** Account ids, first used first. Accounts left out come after, subscriptions before API keys. */
  order: string[];
}

/**
 * One step of the refusal fallback list ("safety priority"): a model, and
 * optionally the account that must answer it (an AccountConfig id from
 * Settings > Models > Accounts). With an account, the call stays on that
 * account: an API key's provider, or a signed in plan by its CLIProxyAPI
 * prefix ("neu/claude-opus-5-5"). A plan without a prefix is asked by its
 * model, and CLIProxyAPI picks among the plans.
 */
export interface RefusalFallbackEntry {
  /** "provider/model", as the model picker gives it. With an account only the model id counts. */
  model: string;
  account?: string;
}

/**
 * Refusal fallback (session/refusal-fallback.ts). When a model refuses (the
 * provider says so: Anthropic stop_reason refusal, OpenAI refusal content or
 * content_filter, Gemini SAFETY and the like, Z.ai sensitive), the hub runs
 * the same turn again on the next entry, with the same messages. It never
 * changes the owner's words and adds no instructions.
 */
export interface RefusalFallbackConfig {
  /** Try the next entry on its own after a refusal. Default false. The "Try the next model" button works whenever the list has entries. */
  enabled?: boolean;
  /** In order, first tried first. */
  entries?: RefusalFallbackEntry[];
  /** After a fallback answers, the session keeps that model for its next turns. Default false: it goes back to its own model. */
  stay?: boolean;
}

/**
 * Built-in subscription sign-in (docs/INSTALL.md, Subscriptions). The hub
 * runs CLIProxyAPI for you (builtin) or uses one you already run (external);
 * either way its models appear under the provider id "cliproxy".
 */
export interface CliproxyConfig {
  /** off (default): nothing runs and providers.cliproxy stays as you set it. */
  mode?: 'off' | 'builtin' | 'external';
  /** external: the CLIProxyAPI address, for example http://192.168.1.10:8317. */
  url?: string;
  /** external: a client key from its access.api-keys. ${secret:name} and ${env:NAME} expand. */
  key?: string;
  /** external, optional: its management key, so sign-in and accounts work from here. ${secret:name} and ${env:NAME} expand. */
  managementKey?: string;
  /** builtin: run this program instead of the one the hub downloads. */
  binary?: string;
  /** builtin: listen on this port of 127.0.0.1. Default: a free port, kept across restarts when it stays free. */
  port?: number;
}

export interface ModelOverride {
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  tools: boolean;
  thinking: boolean;
  /** USD per million tokens. */
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number;
  cacheWritePrice: number;
  /** A 1 hour cache write on Claude models. Default 2x inputPrice. */
  cacheWrite1hPrice: number;
}

export interface HookCommand {
  /** mcp_tool calls a tool on a connected MCP server (Claude Code's handler shape). */
  type: 'command' | 'prompt' | 'mcp_tool';
  command?: string;
  prompt?: string;
  model?: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'
  | 'Notification'
  | 'PermissionRequest';

export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>;

/** Spend and work limits for a node of the session tree (session/limit-tree.ts). Unset or 0 is no limit. */
export interface LimitSpec {
  /** Output tokens, as workflow budgets count them. */
  tokens?: number;
  costUsd?: number;
  /** Model calls. */
  turns?: number;
  /** Working time; waiting for a reset, an approval or an answer does not count. */
  minutes?: number;
}

export interface McpServerConfig {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  /** Only expose these tools (names without the mcp__server__ prefix). */
  tools?: string[];
  /** Working folder for a stdio server (project-scoped servers such as Serena or git). ${env:} and ${secret:} expand. */
  cwd?: string;
  /**
   * Pass the hub's whole environment to a stdio server. Default false: only
   * PATH, HOME, LANG, LC_ALL, TMPDIR, USER and SHELL, plus `env`, so
   * provider keys never reach third-party servers.
   */
  inheritEnv?: boolean;
  /** Longest a tool call on this server may take, in ms. Progress from the server resets it, up to 5 times this. Default 120,000. */
  timeoutMs?: number;
}

/**
 * Gateway routes: anthropic is /gw/anthropic (Claude Code), openai is
 * /gw/openai (Codex, OpenCode), gemini is /gw/gemini (Gemini CLI), provider is
 * /gw/p/<provider id> (any configured provider by id).
 */
export type GatewayRouteId = 'anthropic' | 'openai' | 'gemini' | 'provider';

export interface RemoteConfig {
  /**
   * quick: built-in Cloudflare quick tunnel, no account. stable: a named
   * Cloudflare tunnel on your domain. tailscale or custom: publicUrl.
   * off: no outside address. Unset: custom when publicUrl is set, else off
   * (CONCLAVE_REMOTE overrides it).
   */
  mode?: RemoteMode;
  /** Devices on the same network may connect. Default true. Off answers only this computer and the tunnel. */
  lan?: boolean;
  /** Path to a cloudflared binary. Default: the one the hub downloads into its home. */
  cloudflared?: string;
  /** The named tunnel stable mode made. The API token and the tunnel token live in the secrets store. */
  stable?: {
    accountId: string;
    zoneId: string;
    zone: string;
    hostname: string;
    tunnelId: string;
    dnsRecordId?: string;
    /** Hub port the tunnel's ingress points at; updated when the port changes. */
    port?: number;
  };
}

/** One named browser profile (browser.profiles.<name>). */
export interface BrowserProfileConfig {
  /**
   * chromium (default): Playwright's Chromium or a system Chrome. cloak:
   * CloakBrowser from browser.cloak, with one fixed fingerprint per profile.
   */
  engine?: 'chromium' | 'cloak';
}

export interface ConclaveConfig {
  /** Default "provider/model" for new sessions. */
  defaultModel: string;
  /** Cheap model for titles, summaries, memory extraction, routing. */
  smallModel: string;
  defaultAgent: string;
  /**
   * Device id for new sessions when neither the request nor the agent names
   * one. Falls back to the hub ("local") when that device is not connected.
   */
  defaultDevice?: string;
  providers: Record<string, ProviderConfig>;

  server: {
    host: string;
    port: number;
    /** Bearer token. Generated on first run. */
    token?: string;
    /** Your own address for the hub (a reverse proxy, a domain, or a Tailscale name). Used when remote.mode is custom or tailscale. */
    publicUrl?: string;
    /** Extra allowed CORS origins. */
    cors?: string[];
    /**
     * Addresses of reverse proxies or cloudflared on another machine. A request
     * from one of them is taken to be from the address in its X-Forwarded-For
     * or CF-Connecting-IP header, so lockouts hit the visitor, not the proxy.
     * Loopback is always trusted this way.
     */
    trustedProxies?: string[];
    /** How phones and paired computers reach the hub. See docs/INSTALL.md. */
    remote?: RemoteConfig;
  };

  permissions: {
    mode: PermissionMode;
    allow: string[];
    deny: string[];
    ask: string[];
    /** Extra directories tools may touch outside the session cwd. */
    additionalDirectories: string[];
    /**
     * A write to a file another live chat wrote in the last 10 minutes
     * (alerts/service.ts). warn (default): the write goes ahead, the model
     * hears about it and the Inbox gets an item. ask: that write asks first.
     */
    onFileConflict?: 'warn' | 'ask';
  };

  hooks: HooksConfig;
  mcpServers: Record<string, McpServerConfig>;
  /** MCP tool handling across servers. */
  mcp?: {
    /** With more MCP tools than this, their schemas stay out of requests and load through ToolSearch. Default 30. */
    deferAbove?: number;
  };

  memory: {
    enabled: boolean;
    /** Extract durable facts after sessions end or go idle. */
    autoExtract: boolean;
    /** Inject relevant memories into each user turn. */
    autoInject: boolean;
    /** How many retrieved memories to inject. */
    injectLimit: number;
    /**
     * Let session summaries (episodes) ride along with per-turn recall. Default
     * false: recall brings profile, facts, procedures and goals, and past
     * sessions are searched on demand with SessionSearch.
     */
    recallEpisodes?: boolean;
    /** Optional embeddings for hybrid search: "provider/model". */
    embeddings?: string;
    /** Model the chat import learning job uses. Default smallModel. */
    importModel?: string;
    /** External memory server. */
    external?: {
      type: 'mcp' | 'http';
      /** For mcp: name of an entry in mcpServers. */
      mcpServer?: string;
      /** For http: base URL exposing POST /search and POST /add. */
      url?: string;
      headers?: Record<string, string>;
      /** Basic Memory project to read and write. */
      project?: string;
      /** mirror: write to both. external: only external. */
      mode: 'mirror' | 'external';
    };
    /**
     * Memory connections (docs/MEMORY.md). Each one is searched alongside
     * local memory; writes follow its mode. The legacy `external` entry above
     * still works and shows up as a connection with id "external".
     */
    connections?: Array<{
      /** Slug, unique: lowercase letters, digits, dash, underscore. */
      id: string;
      type: 'basic-memory' | 'mcp' | 'http' | 'mem0' | 'cognee';
      name?: string;
      /** Default true. */
      enabled?: boolean;
      /** mirror: write here and locally. read: search and import only. external: write here instead of locally. Default mirror. */
      mode?: 'mirror' | 'read' | 'external';
      /** Search this connection on every recall. Default true. Set false to rely on imported notes only. */
      search?: boolean;
      /** Per-connection timeout for live search, in ms. Default 2500. */
      timeoutMs?: number;
      /** Type-specific settings (server, url, apiKey, project, tool names...). */
      options?: Record<string, unknown>;
    }>;
  };

  /** Skills agents write (extensions/learned.ts). */
  skills?: {
    /** ask (default): SkillManage writes ask for approval like MemorySave. auto: they run without asking. */
    learn?: 'ask' | 'auto';
  };

  context: {
    /** Fraction of the context window that triggers auto-compaction. */
    compactAt: number;
    /** Tool results longer than this many chars are stored and truncated in context. */
    maxToolResultChars: number;
    /**
     * 0 turns old tool output clearing off. Any other value leaves it on; the
     * turn count itself is no longer used: clearing runs in batches by size
     * (clearProtectTokens, clearBatchTokens) so the prompt cache holds.
     */
    clearToolResultsAfterTurns: number;
    /** Newest tool output kept whole, in tokens. Default 50,000. */
    clearProtectTokens?: number;
    /** Older prunable tool output that starts one clearing batch, in tokens. Default 30,000. */
    clearBatchTokens?: number;
    /**
     * A model switch in a chat over this many tokens of active context shows
     * its price first and offers a short handover (a summary plus the recent
     * turns) next to the full history. Default 50,000. 0 never offers it.
     */
    switchBriefAt?: number;
    /** Use provider prompt caching. */
    promptCaching: boolean;
  };

  /**
   * Prompt cache lifetime on Claude models. Price per token, relative to plain
   * input: a write costs 1.25x at 5m and 2x at 1h; a read costs 0.1x on most
   * models, 0.05x on Opus 5.5 and Sonnet 5.5 and 0.025x on Fable 5.1 and
   * Mythos 5.1, and a read resets the timer. Requests less than 5 minutes
   * apart keep a 5m entry warm, so a 1h write pays off only across a longer
   * gap, such as a person reading the reply before the next turn.
   * auto (default): 5m where nobody waits on the result (subagents, routines,
   * loop mode, headless `conclave run`), 1h in interactive sessions.
   */
  cache?: {
    ttl?: 'auto' | '5m' | '1h';
  };

  limits: {
    /** Automatically continue a session when a rate limit resets. */
    autoResume: boolean;
    resumePrompt: string;
    /** On limit, switch to the next model instead of waiting. key: model ref, value: fallbacks in order. */
    fallbacks: Record<string, string[]>;
    /**
     * Wait instead of falling back when the limit resets within 5 minutes and
     * the chat holds context.switchBriefAt tokens or more, since the fallback
     * would read the whole chat again with no cache. Needs autoResume. Default true.
     */
    waitShortResets?: boolean;
    /** Retries for transient errors (overloaded, network). */
    maxRetries: number;
    /** Model calls per user turn before the loop wraps up with a final reply and no tools. Default 250. */
    maxSteps?: number;
    /** The same for subagents. Default 100. An agent's own maxSteps wins over both. */
    subagentMaxSteps?: number;
    /** Limits for each top-level session and everything it starts. Default none. */
    session?: LimitSpec;
    /** Limits for each top-level routine run and everything it starts. Default 1,000,000 output tokens and 120 minutes. */
    routine?: LimitSpec;
    /** Limits for each subagent and what it starts. Default none. */
    subagent?: LimitSpec;
    /**
     * A running turn with no progress (streamed text, a tool call starting or
     * ending) for this many minutes raises a stuck alert. Default 5; 0 turns
     * it off. `models` overrides it per model ref ("zai/glm-5"), or for a
     * whole provider ("ollama/*").
     */
    stuck?: { minutes?: number; models?: Record<string, number> };
  };

  search: {
    provider: 'auto' | 'brave' | 'tavily' | 'exa' | 'searxng' | 'jina' | 'duckduckgo' | 'serper' | 'serpapi' | 'langsearch' | 'linkup' | 'firecrawl' | 'youcom';
    apiKey?: string;
    apiKeyEnv?: string;
    url?: string;
  };

  browser: {
    /** Chromium-based browser binary. Empty uses the Playwright bundled Chromium or a system Chrome. */
    executablePath?: string;
    headless: boolean;
    /** Persist cookies/logins between runs. */
    profileDir?: string;
    /** Settings per named profile. A profile that is not listed runs on Chromium. */
    profiles?: Record<string, BrowserProfileConfig>;
    /**
     * CloakBrowser, for profiles with engine "cloak". The owner installs the
     * binary; Conclave never downloads or updates it.
     */
    /**
     * The hub's proxy: DataImpulse or one custom proxy. Used only when the
     * owner asks for it in a chat, or a watch's or routine's own instructions
     * do: the browser tools' proxy input. Never by default, never as a
     * fallback (browser/proxy-provider.ts).
     */
    proxy?: BrowserProxyConfig;
    cloak?: {
      /** The CloakBrowser chrome binary, e.g. ~/.cloakbrowser/chromium-146.0.7680.177.5/chrome. */
      executablePath?: string;
      /** sha256 of that file (sha256sum <path>). When set, Conclave refuses to start a binary that does not match. */
      sha256?: string;
    };
  };

  notifications: {
    /** Which events notify. */
    on: {
      sessionDone: boolean;
      approvalNeeded: boolean;
      limitReset: boolean;
      routineDone: boolean;
      errors: boolean;
      /** A friend's hub sent a message or a friend request (docs/design/FRIENDS.md). */
      friendMessage: boolean;
      /** Two live chats wrote the same file within 10 minutes (alerts/service.ts). */
      fileConflict: boolean;
      /** A running turn made no progress for its threshold, or one tool failed the same way 3 times. */
      stuck: boolean;
    };
    /** Hold notifications while a Conclave window was in use within this many seconds. 0 never holds. */
    idleSeconds: number;
    /** Your own VAPID keys for Web Push. Generated and kept in the database when unset. */
    webPush?: { publicKey: string; privateKey: string; subject: string };
    // ntfy and telegram were removed: notifications stay inside Conclave. See config/retired.ts.
  };

  modes: {
    jury: JuryConfig;
    reviewer: string;
  };

  compat: {
    /** Load skills, agents, commands, CLAUDE.md and hooks from ~/.claude and .claude/. */
    claudeCode: boolean;
    /** Load AGENTS.md files (Codex, OpenCode convention). */
    agentsMd: boolean;
    /** Load Codex skills (.agents/skills, ~/.agents/skills, $CODEX_HOME/skills), custom prompts and agent roles. Off unless set. */
    codex?: boolean;
    /** Load OpenCode agents, commands and skills (.opencode/, ~/.config/opencode/). Off unless set. */
    opencode?: boolean;
    /** Load Gemini CLI TOML commands, skills, agents and GEMINI.md (.gemini/, ~/.gemini/). Off unless set. */
    gemini?: boolean;
  };

  /** Model gateway for other CLIs (/gw/*). The server reads the rest of this block (aliases, relay) itself. */
  gateway?: {
    /** Turn single gateway routes off. A route that is not listed is on. */
    routes?: Partial<Record<GatewayRouteId, boolean>>;
  };

  /** Chat import (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.11). */
  import?: {
    /** Every 6 hours, scan online devices and import new chats, so they are copied before the tools delete them. Default off. */
    watch?: boolean;
    /** Mode the watch job imports in. Default chats-learn when memory is on, else chats. */
    watchMode?: 'chats' | 'chats-learn' | 'learn';
  };

  /** Model tiers that agents and workflow steps ask for by word (extensions/model-ref.ts). Unset tiers resolve from smallModel, the session model and the catalog. */
  models?: {
    tiers?: Partial<Record<'fast' | 'smart' | 'deep', string>>;
    /** Models hidden hub-wide (config/hidden.ts): refs or globs with `*` ("cliproxy/glm-*"). Pickers leave them out and nothing runs on them. Empty unless set. */
    hidden?: string[];
    /** Sign in to Claude, ChatGPT, Google and other subscriptions through CLIProxyAPI. Off unless set. */
    cliproxy?: CliproxyConfig;
    /** Accounts and their order (Settings > Models > Accounts, accounts/service.ts). Accounts the hub finds and that are not listed join with defaults. */
    accounts?: AccountConfig[];
    /** Order per vendor, optionally per model match. */
    routes?: AccountRoute[];
    /** Refusal fallback, the owner's "safety priority" (Settings > Models > Refusal fallback). Off and empty unless set. */
    refusalFallback?: RefusalFallbackConfig;
  };

  /** Agents across the hub. */
  agents?: {
    /**
     * Platform awareness (docs/DESIGN.md 51): primary agents get a short card
     * about Conclave, the modes, where things are in the app and what this
     * session can do now; subagents get two lines. Default true. An agent's
     * own `platformCard: false` turns it off for that agent only.
     */
    platformCard?: boolean;
  };

  /** Workflow engine (docs/WORKFLOWS.md). */
  workflows?: {
    /** agent() calls in flight per run. Default 8, at most 16. */
    concurrency?: number;
    /** Calls in flight per provider across all runs. Default 6. */
    perProvider?: number;
    /** Calls in flight across the hub. Default 16. */
    hubMax?: number;
    /** In Ultra, runs whose estimate is under this many tokens start without asking. Default 2,000,000. */
    autoApproveTokens?: number;
    /** agent() calls per run. Default 1000. */
    maxAgents?: number;
  };

  /** Folders across devices (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2). */
  paths?: {
    /** On a move, copy Claude Code and Codex transcripts to the new device. Default off (not built yet). */
    carryTranscripts?: boolean;
    /** More folders to search for a project on any device, after Device.roots or the defaults (~/code, ~/Developer, ~/src, ~/projects, ~/Sync). */
    searchRoots?: string[];
  };

  /**
   * Repo sessions (docs/DESIGN.md 30). The token is the hub secret "github"
   * (Settings, GitHub, or `conclave github login`), else CONCLAVE_GITHUB_TOKEN.
   */
  github?: {
    /** The REST API. Default https://api.github.com (GitHub Enterprise: https://HOST/api/v3). */
    apiUrl?: string;
    /** Where repositories are cloned from and pushed to: <gitUrl>/<owner>/<repo>.git. Default https://github.com. */
    gitUrl?: string;
    /** Where clones go on each device. Default ~/repos (a clone is ~/repos/<owner>/<repo>). */
    reposRoot?: string;
    /** Seconds between checks of open pull requests. Default 120. 0 checks only when asked. */
    pollSeconds?: number;
  };
  /** Places, directions and map images for the assistant (maps/service.ts, Settings > Maps). */
  maps?: MapsConfig;

  /** Updates (docs/DESIGN.md, Updates; Settings > About). */
  updates?: {
    /** Install new releases at night (03:00 to 05:00 on the hub's clock), and update the devices' daemons then. Default off. */
    auto?: boolean;
    /** The daily look at the newest release. Default on; off checks only when asked. */
    check?: boolean;
  };

  /** Hub log files in <home>/logs (docs/DESIGN.md 33). */
  logs?: {
    /** Days of daily files kept. Default 28. */
    keepDays?: number;
    /** All files together stay under this; the oldest days go first. Default 500. */
    maxMB?: number;
    /** Debug lines are written until this time (epoch ms). Settings, Logs sets it for a few hours; 0 is off. */
    debugUntil?: number;
  };

  ui: {
    theme: 'system' | 'dark' | 'light';
    accent?: string;
    /** First-run setup finished or skipped. The web app shows onboarding until this is true. */
    onboarded?: boolean;
    /** Onboarding steps the user completed, for resuming a half-done setup. */
    onboardingSteps?: string[];
    /** The owner's first name. The Chat page greets them with it. */
    name?: string;
  };
}

/**
 * Maps (maps/service.ts). The Google key is a hub secret (providers
 * "google-maps": `conclave secret google-maps` or Settings > Maps), never
 * part of this block.
 */
export interface MapsConfig {
  /** google needs the key and billing; osm needs neither. Default: google when a key is set, else osm. */
  provider?: 'google' | 'osm';
  /** Calls to the provider per local day, across the hub. Cache hits do not count. Default 300. */
  dailyCap?: number;
  /** Where "home" is, for directions and leave-by times. Found once when it is saved. */
  home?: { address: string; lat: number; lng: number; zone?: string };
  /** Default 'transit'. */
  mode?: 'walk' | 'transit' | 'drive' | 'bicycle';
  /** Which app card links open. Default 'google'. */
  links?: 'google' | 'apple';
  osm?: {
    /** Contact email for the public OpenStreetMap servers, as their usage policies ask. */
    email?: string;
    /** Default https://nominatim.openstreetmap.org. */
    nominatimUrl?: string;
    /** Default the public OSRM demo, https://router.project-osrm.org: cars only, light use only. */
    osrmUrl?: string;
    /** OSRM servers with a foot or bike profile. Without one, walk and bicycle times come from the road distance. */
    osrmWalkUrl?: string;
    osrmBicycleUrl?: string;
    /** Default https://tile.openstreetmap.org/{z}/{x}/{y}.png. */
    tileUrl?: string;
  };
}

export const DEFAULT_CONFIG: ConclaveConfig = {
  defaultModel: 'anthropic/claude-sonnet-5-5',
  smallModel: 'anthropic/claude-haiku-5-5',
  defaultAgent: 'assistant',
  providers: {
    anthropic: { type: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    openai: { type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
    google: { type: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' },
    zai: {
      // Chat Completions, as opencode's zai-coding-plan: Z.ai's Anthropic shim drops tools from long tool lists
      type: 'openai',
      name: 'Z.ai Coding Plan',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      // the gateway's Anthropic route (Claude Code pointed at Z.ai) still goes to the shim
      anthropicBaseUrl: 'https://api.z.ai/api/anthropic',
      apiKeyEnv: 'ZAI_API_KEY',
      subscription: 'zai-coding',
      // the Coding Plan's models, newest first (the first one tests the key); keep in step with providers/catalog.ts
      models: ['glm-5.3', 'glm-5.2', 'glm-5.1', 'glm-5', 'glm-5.3-flash', 'glm-4.7', 'glm-4.5-air'],
    },
    openrouter: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
    ollama: { type: 'openai', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', enabled: false },
    cliproxy: {
      type: 'openai',
      name: 'CLIProxyAPI',
      baseUrl: 'http://127.0.0.1:8317/v1',
      apiKeyEnv: 'CLIPROXY_API_KEY',
      enabled: false,
    },
    // the harnesses are engines the owner turns on (Settings, Providers): Conclave runs its own agent loop (acp/harness-off.ts)
    'claude-code': {
      type: 'acp',
      name: 'Claude Code',
      command: 'npx',
      args: ['-y', '@zed-industries/claude-code-acp'],
      subscription: 'claude-max',
      models: ['default', 'opus', 'sonnet', 'haiku'],
      enabled: false,
    },
    codex: {
      type: 'acp',
      name: 'Codex',
      command: 'npx',
      args: ['-y', '@zed-industries/codex-acp'],
      subscription: 'chatgpt',
      models: ['default'],
      enabled: false,
    },
    'gemini-cli': {
      type: 'acp',
      name: 'Gemini CLI',
      command: 'gemini',
      args: ['--experimental-acp'],
      models: ['default'],
      enabled: false,
    },
    opencode: {
      type: 'acp',
      name: 'OpenCode',
      command: 'opencode',
      args: ['acp'],
      models: ['default'],
      enabled: false,
    },
  },
  server: { host: '127.0.0.1', port: 7717 },
  permissions: { mode: 'default', allow: [], deny: [], ask: [], additionalDirectories: [], onFileConflict: 'warn' },
  hooks: {},
  mcpServers: {},
  memory: { enabled: true, autoExtract: true, autoInject: true, injectLimit: 6 },
  context: {
    compactAt: 0.8,
    maxToolResultChars: 30_000,
    clearToolResultsAfterTurns: 12,
    switchBriefAt: 50_000,
    promptCaching: true,
  },
  cache: { ttl: 'auto' },
  limits: {
    autoResume: true,
    resumePrompt: 'The usage limit has reset. Continue where you left off.',
    fallbacks: {},
    waitShortResets: true,
    maxRetries: 4,
    maxSteps: 250,
    subagentMaxSteps: 100,
    routine: { tokens: 1_000_000, minutes: 120 },
    stuck: { minutes: 5 },
  },
  search: { provider: 'auto' },
  browser: { headless: true },
  notifications: {
    on: { sessionDone: true, approvalNeeded: true, limitReset: true, routineDone: true, errors: true, friendMessage: true, fileConflict: true, stuck: true },
    idleSeconds: 60,
  },
  modes: {
    jury: {
      jurors: ['anthropic/claude-sonnet-5-5', 'openai/gpt-5.5', 'zai/glm-5'],
      strategy: 'synthesize',
      anonymize: true,
      jurorTools: 'none',
    },
    reviewer: 'openai/gpt-5.5',
  },
  compat: { claudeCode: true, agentsMd: true },
  agents: { platformCard: true },
  ui: { theme: 'system' },
};
