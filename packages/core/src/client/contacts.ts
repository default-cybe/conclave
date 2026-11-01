/** A recipient, independent of the local or peer carrier (SHARED-WITH-MEMBERS.md 3). */
export type Party = `account:${string}` | `friend:${string}`;

/** Public contact card: no sign-in name, email, grants, addresses or credentials. */
export interface Contact {
  party: Party;
  name: string;
}
