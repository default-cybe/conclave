/** Currencies ledgerkit knows about. Amounts are always stored in cents (hundredths of the unit). */

export interface CurrencyInfo {
  code: string;
  symbol: string;
  /** Digits printed after the decimal point. */
  decimals: number;
}

const CURRENCIES: Record<string, CurrencyInfo> = {
  USD: { code: 'USD', symbol: '$', decimals: 2 },
  EUR: { code: 'EUR', symbol: '€', decimals: 2 },
  GBP: { code: 'GBP', symbol: '£', decimals: 2 },
  JPY: { code: 'JPY', symbol: '¥', decimals: 0 },
};

export function isCurrency(code: string): boolean {
  return Object.hasOwn(CURRENCIES, code.toUpperCase());
}

export function currencyInfo(code: string): CurrencyInfo {
  const info = CURRENCIES[code.toUpperCase()];
  if (!info) throw new Error(`unknown currency: ${code}`);
  return info;
}

export function currencyCodes(): string[] {
  return Object.keys(CURRENCIES);
}
