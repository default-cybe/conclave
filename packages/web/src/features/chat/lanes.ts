/**
 * Security mode lanes (docs/design/SECURITY-MODE.md 1.2): a pure detector
 * over the first message, no model call. It returns every lane whose signal
 * matched, ranked; the composer's Lane picker shows the first and offers the
 * rest. Nothing matched gives [] and the picker asks, defaulting to source.
 */

export type Lane = 'ctf' | 'variant' | 'exploit' | 're' | 'source' | 'web';

export const LANES: Array<{ value: Lane; label: string; short: string; routing: string }> = [
  { value: 'ctf', label: 'CTF', short: 'CTF', routing: 'solver GLM-5.3, validator GLM-5.3, writeup Opus 5.5' },
  { value: 'variant', label: 'variant', short: 'variant', routing: 'hunter Opus 5.5, validator GLM-5.3, refuter Daybreak, reporter Opus 5.5' },
  { value: 'exploit', label: 'exploit dev', short: 'exploit', routing: 'fuzzer GLM-5.3, exploiter Opus 5.5, validator GLM-5.3, reporter Opus 5.5' },
  { value: 're', label: 'RE (REA)', short: 'RE', routing: 'recon GLM-5.3, hunter Opus 5.5, validator GLM-5.3, reporter Opus 5.5' },
  { value: 'source', label: 'white-box source', short: 'source', routing: 'hunter Opus 5.5, validator GLM-5.3, refuter Daybreak, reporter Opus 5.5' },
  { value: 'web', label: 'web black-box (Caido)', short: 'web', routing: 'hunter Opus 5.5, validator GLM-5.3, refuter Daybreak, reporter Opus 5.5' },
];

export const laneLabel = (l: Lane) => LANES.find((x) => x.value === l)?.label ?? l;

const SIGNALS: Array<[Lane, RegExp]> = [
  ['ctf', /flag\{|\bnc\s+\S+\s+\d{2,5}\b|\bchallenge\b/i],
  ['variant', /\bCVE-\d{4}-\d{4,}\b|\bGHSA-[a-z0-9-]{14}\b|github\.com\/[\w.-]+\/[\w.-]+\/(?:commit|pull)\/\w+/i],
  ['exploit', /AddressSanitizer|UndefinedBehaviorSanitizer|\bSIGSEGV\b|\bPo[CV]\b/],
  ['re', /\.(?:ipa|apk|dmg|bin|img|exe|elf|macho)\b|\bfirmware\b/i],
  ['source', /github\.com\/[\w.-]+\/[\w.-]+|\.git\b|(?:^|\s)(?:~|\.{0,2})\/[\w./-]+/i],
  ['web', /https?:\/\/(?!github\.com)[\w.-]+/i],
];

/** Every lane the text signals, in rank order (1.2). */
export function detectLanes(text: string): Lane[] {
  return SIGNALS.filter(([, re]) => re.test(text)).map(([l]) => l);
}
