/**
 * Secrets the owner's transcripts carry that the filter used to miss
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.8). Every value here is fake.
 */
import { describe, expect, test } from 'bun:test';
import { containsSecret, redactSecrets } from '../../src/memory/secrets';

const caught = [
  'export CLOUDFLARE_API_TOKEN=FakeTok3nForTests1234567',
  'GITHUB_TOKEN: ghx_notreal_abcdefghijk',
  'DB_PASSWORD=hunter2isnotreal',
  'SMTP_PASS="notmyrealpass"',
  'PGPWD=s3cretButFake',
  'Authorization: PVEAPIToken=root@pam!backup=2b4c6e8a-1f3d-4b5a-9c7e-0d2f4a6b8c1e',
  'sshpass -p fakePassw0rd ssh root@pve',
  'mysql -uroot -pFakeRootPw1 mydb',
  'curl -u kai:notarealpw https://pve.lan:8006/api2/json',
  'restic backup --password fakeRepoPw /etc',
  'RESTIC_PASSWORD=correct-horse-fake',
  'BORG_PASSPHRASE: fake-borg-phrase',
  'the restic password is 9f8e7d6c5b4a39281706f5e4d3c2b1a0 for the nas repo',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7FakeKeyBodyLine0',
];

const clean = [
  'Restart caddy on madx with systemctl, never reboot madx.',
  'The API_TOKEN is kept in /etc/caddy/env and read at start.',
  'Set CLOUDFLARE_API_TOKEN=$CF_TOKEN in the unit file.',
  'Use DB_PASSWORD=${DB_PASSWORD} from the environment.',
  'mysql -p prompts for the password.',
  'The commit 4f1c2a9b7e3d1f0a8c6b5e4d3c2b1a0f9e8d7c6b fixed the toggle.',
  'curl -u from the docs shows the flag.',
  'The user deploys the portfolio with bun run deploy from the repo root.',
];

describe('secrets filter', () => {
  for (const s of caught) {
    test(`catches: ${s.slice(0, 40)}`, () => {
      expect(containsSecret(s)).toBe(true);
      expect(redactSecrets(s)).not.toBe(s);
    });
  }
  for (const s of clean) {
    test(`leaves alone: ${s.slice(0, 40)}`, () => {
      expect(containsSecret(s)).toBe(false);
    });
  }
});
