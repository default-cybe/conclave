export interface Entry {
  date: Date;
  description: string;
  /** Signed amount in cents. Spending is negative. */
  amountCents: number;
  category: string;
}
