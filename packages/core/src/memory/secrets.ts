/**
 * Secret detection for memory. Anything that looks like a credential is never
 * stored: extraction drops the item, explicit saves get the match redacted.
 */

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, // telegram bot token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /\btk_[A-Za-z0-9]{20,}\b/, // ntfy access token
  /\bhf_[A-Za-z0-9]{30,}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // URL with user:password
  /\b(?:password|passwd|passphrase|pwd)\b\s*[:=]\s*\S+/i,
  /\b(?:password|passphrase|pin code|recovery code)s?\s+(?:is|was|=)\s+\S+/i,
  /\b(?:secret|token|api[_ -]?key|apikey|access[_ -]?key|private[_ -]?key|client[_ -]?secret|auth[_ -]?key)\b\s*[:=]\s*['"]?(?=[^\s'"]*\d)[^\s'"]{8,}/i,
  /\b[A-Fa-f0-9]{48,}\b/, // long hex blobs (keys, not 40-char git shas)
  // misses seen in real transcripts (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.8)
  // CLOUDFLARE_API_TOKEN=..., a quoted value whole (spaces included)
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_?(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|PWD)\s*[:=]\s*(?:"(?![$<{])[^"\n]{4,}"|'(?![$<{])[^'\n]{4,}'|['"]?(?![$<{]|\*{3})(?=[^\s'"]*[^\s'"\d])[^\s'"]{6,})/,
  /\bPVEAPIToken=[^\s'"]+/i, // Proxmox API token
  /\bsshpass\s+-p\s*['"]?[^\s'"]+/,
  /\bmysql(?:dump)?\b[^\n]*?\s-p(?!\s)['"]?[^\s'"]+/,
  /\bcurl\b[^\n]*?\s(?:-u|--user)\s+['"]?[^\s:'"]+:[^\s'"]+/,
  /--password(?:=|\s+)['"]?(?![$<{])[^\s'"]+/,
  /\b(?:RESTIC_PASSWORD|BORG_PASSPHRASE|RESTIC_REPOSITORY_PASSWORD|BORG_PASSCOMMAND)\b\s*[:=]\s*(?:"[^"\n]+"|'[^'\n]+'|[^\s'"]+)/,
  // "the root password for pve is ...", "set the wifi password to ...": a value with a digit or a symbol
  /\b(?:password|passphrase|passwd)\b(?:\s+(?:for|of|on)(?:\s+(?!is\b|was\b)[\w.@:/-]+){1,3})?\s+(?:is|was)\s+['"]?(?=[^\s'"]*[\d!@#$%^&*])[^\s'"]{6,}/i,
  /\b(?:password|passphrase|passwd)\s+(?:to|as)\s+['"]?(?=[^\s'"]*\d)(?=[^\s'"]*[A-Za-z])[^\s'"]{6,}/i,
  /\b(?:docker|podman|nerdctl|helm(?:\s+registry)?)\s+login\b[^\n]*?\s-p\s*['"]?(?![$<{-])[^\s'"]+/,
  /\becho\s+['"]?(?![$<{])[^\s'"|]{4,}['"]?\s*\|\s*sudo\s+(?:-\w+\s+)*-S\b/,
  /\b(?:password|passphrase|passwd)\b[^\n]{0,40}?\b[A-Fa-f0-9]{20,}\b/i,
  /b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]*/, // OpenSSH private key body without its header
  /^(?=[^\n]*\d)(?=[^\n]*[A-Z])(?=[^\n]*[a-z])[A-Za-z0-9+/]{60,76}={0,2}$/m, // PEM body line
  /\b(?=[A-Za-z0-9_+-]*\d)(?=[A-Za-z0-9_+-]*[A-Z])(?=[A-Za-z0-9_+-]*[a-z])[A-Za-z0-9_+-]{40,}={0,2}/, // high entropy base64
];

export function containsSecret(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}

const GLOBAL = PATTERNS.map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));

export function redactSecrets(text: string): string {
  return redactSecretsCounted(text).text;
}

/** redactSecrets, and how many matches it replaced. */
export function redactSecretsCounted(text: string): { text: string; count: number } {
  let count = 0;
  const out = redactSecretsWith(text, () => {
    count++;
    return '[redacted]';
  });
  return { text: out, count };
}

/**
 * Each match goes to `replace`, which returns its replacement, or undefined
 * to leave the match as it is (a value the owner chose to keep).
 */
export function redactSecretsWith(text: string, replace: (match: string) => string | undefined): string {
  let out = text;
  for (const re of GLOBAL) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => replace(m) ?? m);
  }
  return out;
}
