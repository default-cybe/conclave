/**
 * The live view of a session's browser (BrowserLive.tsx): when it shows, and
 * its words. Pure, so the rules are tested (test/browser-live.test.ts).
 */
import type { BrowserLiveDto } from '@conclave/core/client';
import type { Message } from '@conclave/core/types';

/** The hub's browser tools, also when a harness hands them on as mcp__server__browser_x. */
export function isBrowserTool(name: string): boolean {
  return /^browser_/.test(name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name);
}

/** Whether the session used the browser, and whether a browser call is running or waiting now. */
export function browserCalls(messages: readonly Message[] | undefined, running: (toolUseId: string) => boolean): { used: boolean; running: boolean } {
  let used = false;
  for (const m of messages ?? []) {
    for (const b of m.content) {
      if (b.type !== 'tool_use' || !isBrowserTool(b.name)) continue;
      used = true;
      if (running(b.id)) return { used, running: true };
    }
  }
  return { used, running: false };
}

/** The line shows while a browser call runs, or the session's page is open on the hub, or the owner holds it. */
export function showLive(calls: { used: boolean; running: boolean }, live: BrowserLiveDto | undefined): boolean {
  if (live?.held) return true;
  if (!calls.used) return false;
  return calls.running || !!live?.open;
}

/** "Browser, you have it" / "Browser, working on example.com" / "Browser open on example.com". */
export function liveWords(live: BrowserLiveDto | undefined, running: boolean): string {
  const host = hostOf(live?.url);
  if (live?.held) return 'Browser: you have it, the assistant waits';
  if (running) return host ? `Browser, working on ${host}` : 'Browser, working';
  return host ? `Browser open on ${host}` : 'Browser open';
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}
