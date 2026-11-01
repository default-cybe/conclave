export function calcTotal(amounts: number[]): number {
  return amounts.reduce((a, b) => a + b, 0);
}
