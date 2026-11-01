/**
 * Settings come from four places. Later ones win:
 *   built-in defaults < ledgerkit.json in the working folder < environment < command line flags
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCurrency } from './currency';

export interface Config {
  currency: string;
  data: string;
  locale: string;
}

export type ConfigLayer = Partial<Record<keyof Config, string | undefined>>;

export const DEFAULTS: Config = { currency: 'USD', data: 'ledger.csv', locale: 'en-US' };

const KEYS = Object.keys(DEFAULTS) as Array<keyof Config>;

export function readConfigFile(cwd: string): ConfigLayer {
  const file = join(cwd, 'ledgerkit.json');
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`ledgerkit.json: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ledgerkit.json: expected an object');
  const out: ConfigLayer = {};
  for (const k of KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

const ENV_NAMES: Record<keyof Config, string> = { currency: 'LEDGERKIT_CURRENCY', data: 'LEDGERKIT_DATA', locale: 'LEDGERKIT_LOCALE' };

export function configFromEnv(env: Record<string, string | undefined>): ConfigLayer {
  const out: ConfigLayer = {};
  for (const k of KEYS) {
    const v = env[ENV_NAMES[k]];
    if (v) out[k] = v;
  }
  return out;
}

export function resolveConfig(layers: { file: ConfigLayer; env: ConfigLayer; flags: ConfigLayer }): Config {
  const merged: ConfigLayer = { ...layers.flags, ...layers.env, ...layers.file };
  for (const k of KEYS) merged[k] = merged[k] ?? DEFAULTS[k];
  merged.currency = merged.currency!.toUpperCase();
  if (!isCurrency(merged.currency)) throw new Error(`unknown currency: ${merged.currency}`);
  return merged as Config;
}

export function loadConfig(opts: { cwd: string; env: Record<string, string | undefined>; flags: ConfigLayer }): Config {
  return resolveConfig({ file: readConfigFile(opts.cwd), env: configFromEnv(opts.env), flags: opts.flags });
}
