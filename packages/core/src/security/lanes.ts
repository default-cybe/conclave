/**
 * Security mode lanes (docs/design/SECURITY-MODE.md 1.2): a pure detector
 * over the first message and its attachments, no model call. It returns
 * every lane whose signal matched, ranked by the table's order; the lane chip
 * shows the first and offers the rest. Nothing matched gives [] and the chip
 * asks, with white-box source as the default (DEFAULT_LANE).
 *
 * Detection only proposes: the owner changes the lane from the chip, and the
 * engine logs each change on the session (engine.updateSession `lane`).
 */

export type Lane = 'ctf' | 'variant' | 'exploit' | 're' | 'source' | 'web';

/** Rank order, with the words the chip uses and the roles its routing line names. */
export const LANES: ReadonlyArray<{ value: Lane; label: string; short: string; roles: readonly string[] }> = [
  { value: 'ctf', label: 'CTF', short: 'CTF', roles: ['sec-recon', 'sec-exploiter', 'sec-validator', 'sec-reporter'] },
  { value: 'variant', label: 'variant (violation hunt)', short: 'variant', roles: ['sec-hunter', 'sec-validator', 'sec-refuter', 'sec-reporter'] },
  { value: 'exploit', label: 'exploit dev', short: 'exploit', roles: ['sec-fuzzer', 'sec-exploiter', 'sec-validator', 'sec-reporter'] },
  { value: 're', label: 'RE (REA)', short: 'RE', roles: ['sec-recon', 'sec-hunter', 'sec-validator', 'sec-reporter'] },
  { value: 'source', label: 'white-box source', short: 'source', roles: ['sec-hunter', 'sec-validator', 'sec-refuter', 'sec-reporter'] },
  { value: 'web', label: 'web black-box (Caido)', short: 'web', roles: ['sec-recon', 'sec-hunter', 'sec-validator', 'sec-refuter', 'sec-reporter'] },
];

/** Row 7: nothing matched. */
export const DEFAULT_LANE: Lane = 'source';

export const isLane = (v: unknown): v is Lane => typeof v === 'string' && LANES.some((l) => l.value === v);

export const laneLabel = (l: Lane): string => LANES.find((x) => x.value === l)?.label ?? l;

/** session.meta.lane: the lane in use and what the first message matched. `by` owner once the owner picked one from the chip. */
export interface SessionLane {
  lane: Lane;
  detected: Lane[];
  by?: 'owner';
}

export function laneOf(meta: Record<string, unknown> | undefined): SessionLane | undefined {
  const l = meta?.lane as SessionLane | undefined;
  return l && isLane(l.lane) ? { ...l, detected: Array.isArray(l.detected) ? l.detected.filter(isLane) : [] } : undefined;
}

export interface LaneInput {
  text: string;
  /** Attachment file names. */
  files?: readonly string[];
}

const ARCHIVE = /\.(?:zip|tar|tgz|gz|xz|bz2|7z|rar)$/i;
const BINARY_EXT = /\.(?:ipa|apk|dmg|bin|img|exe|elf|so|dylib|dll|macho|fw)$/i;
const POC_FILE = /(?:^|[\W_])(?:po[cv]|crash|repro)(?:[\W_]|$)/i;
// a git host repo URL, or a .git URL (one character before .git, not \S+: no backtracking on long runs)
const REPO = /\b(?:github|gitlab)\.com\/[\w.-]+\/[\w.-]+|\S\.git\b/i;
// a folder path: ~/x/, ./x/, ../x/ or an absolute path with at least two parts
const FOLDER = /(?:^|\s)(?:~|\.{1,2})?\/[\w.-]+\/[\w./-]*/;
const URL_RE = /\bhttps?:\/\/([\w.-]+)/gi;
// a bare host with a common TLD (app.example.com), not a file name such as main.go
const BARE_HOST = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|co|ai|cloud|xyz|me|us|uk|de|in|gov|edu)\b/i;
const GIT_HOST = /^(?:www\.)?(?:github|gitlab)\.com$/;

/** Every lane the first message signals, in rank order (1.2). */
export function detectLanes(input: LaneInput | string): Lane[] {
  const { text, files = [] } = typeof input === 'string' ? { text: input } : input;
  const hit = new Set<Lane>();
  // 1. CTF bundle: flag{, an nc host port line, or "challenge" with files attached; outranks a crash log inside it
  if (/flag\{/i.test(text) || /(?:^|\s)nc\s+[\w.-]+\s+\d{2,5}\b/m.test(text) || (/\bchallenge\b/i.test(text) && files.length > 0) || (/\bctf\b/i.test(text) && files.some((f) => ARCHIVE.test(f)))) hit.add('ctf');
  // 2. advisory or fix: CVE, GHSA, or a commit or PR URL
  if (/\bCVE-\d{4}-\d{4,}\b/i.test(text) || /\bGHSA-[a-z0-9-]{14}\b/i.test(text) || /\b(?:github|gitlab)\.com\/[\w.-]+\/[\w.-]+\/(?:-\/)?(?:commit|pull|merge_requests)\/\w+/i.test(text)) hit.add('variant');
  // 3. crash log (a sanitizer, or SIGSEGV with a stack), or an attached PoV/PoC
  if (/AddressSanitizer|UndefinedBehaviorSanitizer|MemorySanitizer/.test(text) || (/\bSIGSEGV\b/.test(text) && /#\d+\s+0x[0-9a-f]+|\bstack\b|\bbacktrace\b/i.test(text)) || files.some((f) => POC_FILE.test(f))) hit.add('exploit');
  // 4. binary or firmware, named in the text or attached
  if (/\b(?:ELF|Mach-O|PE32\+?)\b/.test(text) || /\bfirmware\b/i.test(text) || /[\w-]\.(?:ipa|apk|dmg|bin|img|exe)\b/i.test(text) || files.some((f) => BINARY_EXT.test(f))) hit.add('re');
  // 5. a repository or a source folder (URLs taken out first, so a web path is not a folder)
  if (REPO.test(text) || FOLDER.test(text.replace(/\bhttps?:\/\/\S+/gi, ' '))) hit.add('source');
  // 6. any other URL or host: a GitHub or GitLab link is source, not web
  const hosts = [...text.matchAll(URL_RE)].map((m) => m[1].toLowerCase());
  // word by word, so no pattern backtracks over a long run of one character (CodeQL js/polynomial-redos)
  const bare = text
    .split(/\s+/)
    .filter((w) => !/https?:\/\//i.test(w) && !/\b(?:github|gitlab)\.com\//i.test(w) && !/\.git\b/i.test(w))
    .join(' ');
  if (hosts.some((h) => !GIT_HOST.test(h)) || BARE_HOST.test(bare)) hit.add('web');
  return LANES.map((l) => l.value).filter((l) => hit.has(l));
}
