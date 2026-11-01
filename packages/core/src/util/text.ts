/** Rough token estimate: ~4 chars per token for English and code. Good enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateMiddle(text: string, max: number, note = 'truncated'): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[... ${dropped} chars ${note} ...]\n\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

export function oneLine(text: string, max = 120): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Parse "1h30m", "90s", "2d" into ms. */
export function parseDuration(s: string): number | undefined {
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/g;
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    total += n * ({ ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 } as Record<string, number>)[unit];
  }
  return matched ? total : undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}
