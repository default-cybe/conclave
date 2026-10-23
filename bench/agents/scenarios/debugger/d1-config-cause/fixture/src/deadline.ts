import config from '../config.json';

/** When a step that started at `start` (epoch ms) must give up. */
export function deadline(start: number): number {
  return start + config.timeoutSeconds * 1000;
}

export function expired(start: number, now: number): boolean {
  return now > deadline(start);
}
