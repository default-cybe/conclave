export interface Line { cents: number; qty: number }

/** Total of a cart in cents. */
export function cartTotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.cents, 0);
}
