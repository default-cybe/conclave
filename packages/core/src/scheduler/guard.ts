/**
 * Deny rules that go with an allow rule's prefix (ECOSYSTEM.md 5.3, P0).
 *
 * A prefix rule such as Bash(git clone --depth 30:*) allows any words after
 * it, and some programs take options that run another program, send the
 * login somewhere else, change settings or delete data:
 * git clone --upload-pack runs a program, gh api --method GET -X DELETE sends
 * a DELETE, conclave --hub sends the hub token to another address, and
 * journalctl --vacuum-time deletes logs. Suggested routines and shipped
 * templates carry these next to their allow rules. In a deny rule ** stands
 * for any text, so "Bash(git ** -c**)" refuses -c anywhere after git.
 *
 * Plain data, no imports: the web app shows the same rules in the Add sheet.
 */
export const GUARD_DENY: ReadonlyArray<{ prefix: string; deny: readonly string[] }> = [
  { prefix: 'Bash(conclave ', deny: ['Bash(conclave ** --hub**)', 'Bash(conclave ** --token**)'] },
  { prefix: 'Bash(gh api ', deny: ['Bash(gh api ** -X**)', 'Bash(gh api ** --method**)', 'Bash(gh api **graphql**)', 'Bash(gh api --method GET http**)'] },
  {
    prefix: 'Bash(git ',
    deny: ['Bash(git ** --upload-pack**)', 'Bash(git ** -u**)', 'Bash(git ** -c**)', 'Bash(git ** --config**)', 'Bash(git ** --template**)', 'Bash(git **ext::**)'],
  },
  { prefix: 'Bash(openssl ', deny: ['Bash(openssl ** -keylogfile**)', 'Bash(openssl ** -sess_out**)', 'Bash(openssl ** -msgfile**)', 'Bash(openssl ** -out**)'] },
  {
    prefix: 'Bash(smartctl ',
    deny: ['Bash(smartctl ** -t**)', 'Bash(smartctl ** --test**)', 'Bash(smartctl ** -X**)', 'Bash(smartctl ** --abort**)', 'Bash(smartctl ** -s**)', 'Bash(smartctl ** --smart**)', 'Bash(smartctl ** -S**)', 'Bash(smartctl ** -o**)', 'Bash(smartctl ** --set**)'],
  },
  // -H and -M run the command on another host or container over ssh or machinectl
  { prefix: 'Bash(systemctl ', deny: ['Bash(systemctl ** -H**)', 'Bash(systemctl ** --host**)', 'Bash(systemctl ** -M**)', 'Bash(systemctl ** --machine**)'] },
  // -r and -e remove or edit a crontab, -n changes the cron cluster host
  { prefix: 'Bash(crontab ', deny: ['Bash(crontab ** -r**)', 'Bash(crontab ** -e**)', 'Bash(crontab ** -n**)'] },
  // --checkpoint writes a file
  { prefix: 'Bash(ausearch ', deny: ['Bash(ausearch ** --checkpoint**)'] },
  {
    prefix: 'Bash(journalctl ',
    deny: ['Bash(journalctl ** --vacuum**)', 'Bash(journalctl ** --rotate**)', 'Bash(journalctl ** --flush**)', 'Bash(journalctl ** --sync**)', 'Bash(journalctl ** --relinquish-var**)', 'Bash(journalctl ** --setup-keys**)', 'Bash(journalctl ** --update-catalog**)'],
  },
];

/** The deny rules an allow list needs, merged with the ones it already has. Undefined when there are none. */
export function guardDeny(allow: readonly string[] | undefined, deny?: readonly string[]): string[] | undefined {
  const extra = GUARD_DENY.filter((g) => (allow ?? []).some((r) => r.startsWith(g.prefix))).flatMap((g) => g.deny);
  const out = [...new Set([...(deny ?? []), ...extra])];
  return out.length ? out : undefined;
}
