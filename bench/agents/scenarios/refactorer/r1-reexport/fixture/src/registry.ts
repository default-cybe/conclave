import * as convert from './convert';

/** Converters by name, as the CLI's --to flag spells them. */
const NAMES: Record<string, string> = { c: 'toCelsius' };

export function converter(flag: string): (n: number) => number {
  const fn = (convert as Record<string, (n: number) => number>)[NAMES[flag]];
  if (!fn) throw new Error(`unknown unit ${flag}`);
  return fn;
}
