/** Format an amount in cents for display, for example formatPrice(1999) is "19.99 EUR". */
export function formatPrice(cents: number, currency = 'EUR'): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
