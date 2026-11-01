import { calcTotal } from './total';

export function reportLine(name: string, amounts: number[]): string {
  return `${name}: ${calcTotal(amounts).toFixed(2)}`;
}
