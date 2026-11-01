/** Prompt history in ~/.conclave/history, one JSON string per line. */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX = 1000;

export class History {
  private entries: string[] = [];
  private index = -1;
  private draft = '';

  constructor(private file?: string) {
    if (!file || !existsSync(file)) return;
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const v = JSON.parse(l);
          if (typeof v === 'string') this.entries.push(v);
        } catch {
          this.entries.push(l);
        }
      }
      if (this.entries.length > MAX * 1.5) {
        this.entries = this.entries.slice(-MAX);
        writeFileSync(file, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
      }
    } catch {
      /* unreadable history is not fatal */
    }
  }

  get all(): readonly string[] {
    return this.entries;
  }

  push(entry: string): void {
    this.reset();
    const v = entry.trim();
    if (!v || this.entries[this.entries.length - 1] === v) return;
    this.entries.push(v);
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(v) + '\n', { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }

  /** Older entry, or undefined at the oldest. `current` is kept as the draft. */
  prev(current: string): string | undefined {
    if (!this.entries.length) return undefined;
    if (this.index === -1) {
      this.draft = current;
      this.index = this.entries.length - 1;
    } else if (this.index > 0) this.index--;
    else return undefined;
    return this.entries[this.index];
  }

  /** Newer entry; past the newest returns the saved draft. */
  next(): string | undefined {
    if (this.index === -1) return undefined;
    if (this.index < this.entries.length - 1) {
      this.index++;
      return this.entries[this.index];
    }
    this.index = -1;
    return this.draft;
  }

  reset(): void {
    this.index = -1;
    this.draft = '';
  }

  get browsing(): boolean {
    return this.index !== -1;
  }
}
