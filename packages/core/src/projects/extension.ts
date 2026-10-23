/**
 * The projects service's runner extension (session/runner-ext.ts):
 *
 * - beforeStep: a session whose paired device is offline parks as
 *   waiting_input ("macbook is offline. Wait, or run on another device.")
 *   and goes on when the device is back or the session moves (2.1 bug 1).
 * - beforeTool: the write gate (2.8). After a move to a folder below an
 *   exact match, the first Write, Edit, MultiEdit, NotebookEdit or Bash call
 *   that can change files asks once for that folder. The runner shows the
 *   prompt, merged with its own when the call would ask anyway, so the
 *   owner answers once. A mismatch asks every time, unless the owner chose
 *   Use and remember when moving.
 * - toolContext and afterTool: file tools map paths under an old folder of
 *   the session to the new one (2.7); the result says so once per folder.
 *   afterTool also marks the folder approved once a gated call ran.
 */
import type { MatchLevel } from '../client/projects';
import type { RunnerExtension } from '../session/runner-ext';
import type { ToolOutput } from '../tools/types';
import type { ProjectsService } from './service';
import type { SessionLocationRow } from './store';

/** Tools the write gate covers. */
export const GATED_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']);

const LEVEL_SHORT: Record<MatchLevel, string> = {
  exact: 'Exact match',
  strong: 'Strong match',
  weak: 'Weak match',
  none: 'Not matched',
  mismatch: 'Mismatch',
};

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * The reason on the approval card: the folder, the match level and the
 * freshness line, e.g. "First change in ~/Developer/portfolio on macbook
 * since this session moved there. Strong match: same git history as the
 * arch-desktop copy. The macbook copy is 1 commit behind."
 */
export function gateReason(input: { folder: string; deviceName: string; level: MatchLevel; line?: string; freshness?: string }): string {
  const how = input.line ? `${LEVEL_SHORT[input.level]}: ${lowerFirst(input.line.replace(/\.$/, ''))}.` : `${LEVEL_SHORT[input.level]}.`;
  const head =
    input.level === 'mismatch'
      ? `A change in ${input.folder} on ${input.deviceName} since this session moved there. Each change there asks first.`
      : `First change in ${input.folder} on ${input.deviceName} since this session moved there.`;
  return [head, how, input.freshness].filter(Boolean).join(' ');
}

export function projectsExtension(svc: ProjectsService): RunnerExtension {
  /** Gated calls waiting for the owner, by tool use id: the move they belong to. */
  const asked = new Map<string, SessionLocationRow>();

  return {
    name: 'projects',

    async beforeStep(ctx) {
      const s = ctx.session;
      if (s.kind === 'chat') return;
      // the path map is filled once per session before its first step
      if (ctx.iter === 0 && !svc.hasPathMap(s)) await svc.refreshPathMap(s).catch(() => undefined);
      if (svc.online(s.device)) return;
      const name = svc.deviceName(s.device);
      const sugg = await svc.suggestion(s).catch(() => undefined);
      const also = sugg ? ` Your folder is also on ${sugg.deviceName} at ${sugg.cwd}${sugg.via === 'syncthing' ? ' (Syncthing)' : ''}.` : '';
      return {
        park: `${name} is offline. Wait, or run on another device.${also}`,
        until: (signal) => svc.waitForDevice(s.id, s.device, signal),
      };
    },

    async beforeTool(ctx) {
      if (ctx.readOnly || !GATED_TOOLS.has(ctx.tool.name)) return;
      const cur = svc.pendingGate(ctx.session);
      if (!cur) return;
      if (asked.size > 200) asked.clear();
      asked.set(ctx.toolUseId, cur);
      return { decision: 'ask', reason: await svc.gateText(ctx.session, cur) };
    },

    toolContext(session) {
      const roots = svc.pathMap(session);
      return roots?.length ? { pathMap: { roots, hits: [] } } : undefined;
    },

    afterTool(ctx, toolCtx, output): ToolOutput | undefined {
      // the call ran, so the owner allowed it: one yes covers the folder, except a mismatch
      const gate = asked.get(ctx.toolUseId);
      if (gate) {
        asked.delete(ctx.toolUseId);
        svc.passGate(gate);
      }
      const hits = toolCtx.pathMap?.hits ?? [];
      if (!hits.length) return;
      const fresh = svc.takeUnnoted(ctx.session, hits);
      const meta = { ...(output.meta ?? {}), mappedFrom: hits[0] };
      if (!fresh.length) return { ...output, meta };
      const lines = fresh.map((from) => {
        const r = toolCtx.pathMap!.roots.find((x) => x.from === from);
        const was = r?.device ? ` on ${svc.deviceName(r.device)}` : '';
        return `Conclave mapped ${from} to ${r?.to ?? 'the current folder'}: that was this session's folder${was} before it moved, and it is not on this device.`;
      });
      const note = `\n\n(${lines.join(' ')})`;
      const content = typeof output.content === 'string' ? output.content + note : [...output.content, { type: 'text' as const, text: note }];
      return { ...output, content, meta };
    },
  };
}
