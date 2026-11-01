/**
 * OAuth scopes for /mcp (docs/design/MCP-OAUTH.md). Each one has the words
 * the consent screen and Settings > Connected apps show.
 */
import type { OAuthScope } from '@conclave/core/client/index.ts';

export const SCOPES: readonly OAuthScope[] = ['memory:read', 'memory:write', 'chats:read'];

export const SCOPE_WORDS: Record<OAuthScope, string> = {
  'memory:read': "Read your memory: your profile, facts, goals, tasks and today's plan",
  'memory:write': 'Save new memories and forget old ones',
  'chats:read': 'Search your past chats',
};

/** Asked for by clients that want a refresh token. Accepted and dropped: every grant gets one. */
export const OFFLINE_ACCESS = 'offline_access';

export function isScope(s: string): s is OAuthScope {
  return (SCOPES as readonly string[]).includes(s);
}

/** Space separated words to known scopes, in table order, without repeats. */
export function parseScopes(text: string | null | undefined): OAuthScope[] {
  const asked = new Set((text ?? '').split(/\s+/).filter(Boolean));
  return SCOPES.filter((s) => asked.has(s));
}

/** Words in the request that are not scopes we know (offline_access aside). */
export function unknownScopes(text: string | null | undefined): string[] {
  return (text ?? '').split(/\s+/).filter((s) => s && s !== OFFLINE_ACCESS && !isScope(s));
}

export function scopeText(list: readonly OAuthScope[]): string {
  return SCOPES.filter((s) => list.includes(s)).join(' ');
}
