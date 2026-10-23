export function toCelsius(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 10) / 10;
}
