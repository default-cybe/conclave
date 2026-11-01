/**
 * How current a copy is (ROUND-IMPORT-PATHS-WORKFLOWS.md 2.8). At the end of
 * each turn the session's device, root, branch, HEAD and dirty count are
 * kept (location_state). On a move the target is checked against that: does
 * it have the last commit, how far behind or ahead it is, and whether
 * Syncthing is still pulling. The owner sees one line. How many
 * *.sync-conflict-* files sit in the folder is kept too, for the session's
 * details, not the line.
 */
import type { Machine } from '../machine/types';
import type { SyncthingStatus } from '../machine/syncthing';
import type { Freshness } from '../client/projects';
import type { FolderProbe } from './identity';
import { hasCommit } from './identity';
import type { LocationStateRow } from './store';
import { shellQuote } from '../tools/util';

async function aheadBehind(machine: Machine, root: string, sha: string): Promise<{ behind: number; ahead: number } | undefined> {
  const res = await machine.exec(`git -C ${shellQuote(root)} rev-list --left-right --count ${sha}...HEAD 2>/dev/null`, { cwd: '/', timeoutMs: 10_000 });
  const m = /^(\d+)\s+(\d+)/.exec(res.stdout.trim());
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : undefined;
}

async function conflictFiles(machine: Machine, root: string): Promise<number> {
  const res = await machine.exec(`find ${shellQuote(root)} -maxdepth 6 -name node_modules -prune -o -name '*.sync-conflict-*' -print 2>/dev/null | head -n 50 | wc -l`, { cwd: '/', timeoutMs: 5_000 });
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface FreshnessInput {
  target: Machine;
  root: string;
  probe?: FolderProbe;
  /** location_state of the session: where it was at the end of its last turn. */
  last?: LocationStateRow;
  /** Name of the device the session was on. */
  fromName: string;
  /** Name of the target device. */
  toName: string;
  /** Syncthing state of the folder on the target, when it is synced. */
  sync?: SyncthingStatus;
  /** The synced folder is paused on the target, so it takes no changes. */
  paused?: boolean;
}

/** Check the target copy. Never throws; checks that fail are left out. */
export async function checkFreshness(input: FreshnessInput): Promise<Freshness> {
  const { target, root, probe, last } = input;
  const f: Freshness = { stale: false };
  const lines: string[] = [];
  const isGit = probe ? probe.isGit : true;
  try {
    if (isGit && last?.head && probe?.head !== last.head) {
      if (await hasCommit(target, root, last.head)) {
        const ab = await aheadBehind(target, root, last.head);
        if (ab) {
          f.behind = ab.behind;
          f.ahead = ab.ahead;
          if (ab.behind > 0) lines.push(`The ${input.toName} copy is ${plural(ab.behind, 'commit')} behind.`);
        }
      } else {
        f.missingCommit = true;
        lines.push(`The ${input.toName} copy does not have the last commit from ${input.fromName} (${last.head.slice(0, 7)}).`);
      }
    }
  } catch {
    /* git checks are best effort */
  }
  if (input.paused) {
    f.syncState = 'paused';
    lines.push(`Syncthing is paused for this folder on ${input.toName}, so it may be out of date.`);
  } else if (input.sync) {
    f.syncState = input.sync.state;
    f.needFiles = input.sync.needFiles;
    if (input.sync.state !== 'idle' || input.sync.needFiles > 0) lines.push(`Syncthing is still syncing this folder${input.sync.needFiles ? ` (${plural(input.sync.needFiles, 'file')} to go)` : ''}.`);
    else if (input.sync.pullErrors > 0) lines.push(`Syncthing has ${plural(input.sync.pullErrors, 'error')} for this folder.`);
  }
  // conflict files are kept for the session's details: they are no reason to stop a move or show the banner
  try {
    const conflicts = await conflictFiles(target, root);
    if (conflicts) f.conflicts = conflicts;
  } catch {
    /* best effort */
  }
  // uncommitted work does not travel with git; a synced folder carries it
  if (last?.dirty && last.dirty > 0 && !probe?.syncthing && last.root !== root) {
    f.dirtyElsewhere = last.dirty;
    lines.push(`${input.fromName} had ${plural(last.dirty, 'uncommitted file')} that ${last.dirty === 1 ? 'is' : 'are'} not here.`);
  }
  if (lines.length) {
    f.stale = true;
    f.line = lines[0];
  }
  return f;
}
