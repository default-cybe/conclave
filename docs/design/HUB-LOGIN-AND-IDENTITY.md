# Password login and hub identity

Two additions to pairing. The QR code stays the main way in.

## 1. Password login (a backup to the QR code)

For a phone without a camera to hand, or a hub whose Devices page you cannot open.

- **Off until the owner sets a password.** Owner only: `PUT /api/auth/password {password}` (12 characters or more), `DELETE /api/auth/password`, `GET /api/auth/password` gives `{ set: boolean, setAt?: number }`. The CLI has `conclave password set` (asks twice, no echo) and `conclave password clear`.
- **Stored as an argon2id hash** (`Bun.password.hash`) in the hub's key-value store, never in config.json, never in a backup.
- **Login:** `POST /api/login {password, name, platform}` (no auth) gives the same reply as `POST /api/pair`. A wrong password, or no password set, gives one message: "Wrong password, or no password is set on this hub." It counts as a failed pairing attempt for the address (the same rate limit and block as wrong pairing codes), and the audit log gets `login.failed` or `login.client`.
- **Clients send a password only over https, or to a loopback or private address** (10/8, 172.16/12, 192.168/16, 100.64/10, fd00::/8, `*.local`, `*.ts.net`). Over plain http to anything else they refuse before sending: "Use the https address of your hub to log in with a password."

## 2. Hub identity (the phone never sends its token to a stranger)

A phone on public Wi-Fi can reach a machine that is not the hub at an address the hub used to have (a reused LAN address, a quick tunnel name that changed hands). Today the app sends its token to whatever answers. Now the hub proves who it is first.

- **The hub has an Ed25519 key pair**, made on first start and kept in its data folder (mode 600). Its public key is 32 raw bytes; `publicKey` is that in base64url without padding; `fingerprint` is the first 16 bytes of SHA-256 of the raw key, as 32 lowercase hex characters.
- **`GET /api/identity?nonce=<16 to 128 base64url chars>`** (no auth) gives `{ publicKey, fingerprint, signature }`. `signature` is base64url of the Ed25519 signature of the UTF-8 text `conclave-hub-identity-v1\n<nonce>`. A missing or bad nonce gives 400.
- **QR codes carry the fingerprint:** `conclave://pair?url=...&code=...&fp=<fingerprint>&alt=...`. `POST /api/pair` and `POST /api/login` replies add `identity: { publicKey, fingerprint }`. `GET /api/info` adds `fingerprint` so Settings can show it.
- **Pairing with a QR code:** the client checks the hub at `url` against `fp` (identity call with a fresh nonce) before it sends the pairing code. A mismatch stops pairing: "This address is not the hub that made the code."
- **Password login:** no fingerprint to check against, so the first answer is trusted and its key kept. The login screen shows the fingerprint once, split in groups of four, next to where Settings on the hub shows it.
- **Every later connection:** the client keeps the hub's `publicKey` next to its token. Before the first request or socket to an address (not loopback), it checks that address with a fresh nonce, and checks it again after 10 minutes or after a reconnect. A wrong key or a bad signature means it sends nothing: `HubIdentityError`, shown as "This address is not your hub. Conclave did not send your sign-in." with a way to pick another address or pair again. A hub that does not answer the identity call is offline, not a stranger.
- **Clients paired before this change** keep the key from their first identity check (trust on first use).
- **Not covered:** the device daemon (it pairs with device codes and connects on its own), and the web app served by the hub itself (same origin, nothing to check).

## 3. Settled while building the hub and the TypeScript client

Additions only; nothing above changed shape.

- **Hub files.** The key is PKCS#8 PEM in `<home>/hub-key.pem`, next to `secrets.json`. A file that is not an Ed25519 key stops the hub with a message, rather than a new key quietly turning every app away. The password is `{hash, setAt}` under `auth.password` in the kv table; backups do not read that table. The key is not in backups either (nor are client tokens), so a hub restored on a new machine pairs again.
- **Hub replies.** `PairingInfo` adds `fingerprint` (the `fp` in its deep link), and `hub` in the pair and login replies carries `fingerprint` too. `fp` comes right after `code` in the link, before any `alt`. The block message for an address is now "Too many wrong pairing codes or passwords from this address. Try again in N seconds." The audit log also gets `login.blocked`, `password.set` and `password.clear`.
- **The shared client** (`packages/core/src/client/index.ts`) exports:
  - `verifyIdentity(proof, nonce, publicKey?)`: `Promise<boolean>`. True when the proof's key is `publicKey` (or, left out, the key the proof names), its fingerprint is that key's, and the signature checks out.
  - `fingerprintOf(publicKey)`: `Promise<string>`. `formatFingerprint(fp)`: groups of four.
  - `isPrivateAddress(url)`: the address list in section 1; takes a URL or a bare host.
  - `newNonce()`, `IDENTITY_PREFIX`, `IDENTITY_TTL_MS`.
  - On `ConclaveClient`: a `hubKey` field (set it with `token` after pairing); `checkIdentity({ publicKey?, fingerprint? })`, which returns the `HubIdentity` or throws `HubIdentityError` (use `{ fingerprint: fp }` for a QR code, and nothing for trust on first use); `forgetIdentity()` to check again before the next call (a network change); and `connect(..., { onIdentityError })`, called when a socket was not opened because another key answered. The socket keeps retrying with backoff, checking each time.
- **What counts as a stranger.** A wrong key, a bad signature, a 4xx other than 429, or an answer that is not a proof (a captive portal page): `HubIdentityError`. No answer: the network error as it is. A 5xx or 429: `ApiError`. The hub's own network refusal (403 with `code: "network"`) is an `ApiError` too, with the client's own message (`NETWORK_REFUSED`), since anything can send that body; nothing is sent either way. `identity()` never carries the token.
- **Not checked:** loopback, and a `baseUrl` with the page's own origin (the web app the hub serves).
- **WebCrypto.** The check uses Ed25519 and SHA-256 from `crypto.subtle`. A platform without Ed25519, or a plain http page without `crypto.subtle`, gets a plain Error and nothing is sent; the app cannot check, so it does not guess.
- **CLI.** `conclave login <url> --password` logs in with the password; every login saves `hubKey` and `fingerprint` in `client.json`, and a login saved before this keeps the key from its first check. `conclave password` alone shows whether one is set. `conclave pair` and `conclave serve` show the fingerprint.

## Who builds what

| Part | Where |
|---|---|
| Hub: key pair, `/api/identity`, `fp` in QR codes, password routes, `/api/login`, CLI | `packages/server`, `packages/cli` |
| TypeScript client: the check before sending a token, `HubIdentityError`, password-over-http rule | `packages/core/src/client` |
| Web and iPhone app: Connect with address and password, fingerprint shown, password in Settings, the error screen | `packages/web` |
| Android: the same in `:client` (Tink `Ed25519Verify`) and the app | `packages/android` |
| Desktop app: Password on its first page (`hub::login` in Rust), the fingerprint shown before the token is kept | `packages/desktop` |
