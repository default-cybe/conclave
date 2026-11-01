# Sign in to /mcp with OAuth

Why: the owner wants claude.ai and ChatGPT to use Conclave's memory, so every
chatbot shares one memory. Claude Code, Codex and OpenCode already reach
`/mcp` with the hub token or a gateway key in a header. claude.ai custom
connectors and ChatGPT apps cannot send a fixed header. They follow the MCP
authorization flow: OAuth 2.1 with PKCE, found through protected resource
metadata, with a client that registers itself.

This page is the plan, written before the code, and the threat list with the
test that covers each threat. How to use it is in `docs/MEMORY.md`, section
Sharing memory with other tools.

## What the clients need

Sources: the MCP authorization spec (2025-11-25, and the 2026-07-28 revision
that adds RFC 9207, prefers client ID metadata documents and keeps dynamic
registration for older clients), Claude's "Authentication for connectors"
(claude.com/docs/connectors/building/authentication) and "Lazy
authentication" pages, the Claude help article "Get started with custom
connectors using remote MCP", and OpenAI's "Authentication" page for ChatGPT
apps (developers.openai.com/plugins/build/auth). The OpenAI pages could not
be fetched from the build machine; their points here come from search
summaries of those pages.

- A `401` from `/mcp` with `WWW-Authenticate: Bearer resource_metadata="..."`.
  Claude ignores the header on any other status.
- Protected resource metadata (RFC 9728) whose `resource` is exactly the URL
  the owner typed, `https://<hub>/mcp`, served at
  `/.well-known/oauth-protected-resource/mcp` and at
  `/.well-known/oauth-protected-resource`. Claude uses only the first entry
  of `authorization_servers`.
- Authorization server metadata (RFC 8414) at
  `/.well-known/oauth-authorization-server`, with
  `code_challenge_methods_supported: ["S256"]`.
- A client identity. Claude and ChatGPT both use a client ID metadata
  document (the `client_id` is an https URL) when the metadata has
  `client_id_metadata_document_supported: true` and `none` in
  `token_endpoint_auth_methods_supported`. Otherwise they use dynamic client
  registration (RFC 7591) at `registration_endpoint`. The hub does both.
- Client authentication for a document. Claude's documents say
  `token_endpoint_auth_method: none`. ChatGPT's says `private_key_jwt`, names
  `RS256` and points `jwks_uri` at its public keys. OpenAI's page says
  ChatGPT supports `none` and `private_key_jwt` for documents, and the
  server metadata must list `private_key_jwt`. The hub takes both, and
  refuses every method built on a client secret, as the draft says.
- Redirect URIs: `https://claude.ai/api/mcp/auth_callback` for the hosted
  Claude apps, a loopback URI on any port for Claude Code
  (`http://localhost:<port>/callback` and `http://127.0.0.1:<port>/callback`),
  and `https://chatgpt.com/connector_platform_oauth_redirect` for ChatGPT when
  the server returns `iss`, else a per-app `https://chatgpt.com/connector/oauth/<id>`.
  The hub does not list these. Each client registers or declares its own.
- `iss` on every authorization response, success and error, when the
  metadata says `authorization_response_iss_parameter_supported: true`
  (RFC 9207). ChatGPT fails the sign in when the flag is set and `iss` is
  missing.
- The `resource` parameter (RFC 8707) on authorize and token requests.
- A token endpoint that reads `application/x-www-form-urlencoded`, answers
  in under 10 seconds (30 for refresh), returns `invalid_grant` for a dead
  refresh token, and rotates refresh tokens for public clients.
- `scope` in the `401` challenge decides what Claude asks for. Claude adds
  `offline_access` when the authorization server lists it.
- A missing scope at call time is a `403` with
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`, sent
  before the MCP SDK runs. A tool error inside a `200` does not start a new
  sign in.
- The consent screen shows the redirect URI's host, with an extra warning
  when the client only redirects to loopback addresses.

## The flow as built

1. The client calls `/mcp` without a token. The hub answers `401` with
   `resource_metadata` and `scope="memory:read memory:write chats:read"`.
2. The client reads `/.well-known/oauth-protected-resource/mcp`, then
   `/.well-known/oauth-authorization-server` on the same origin.
3. The client registers at `POST /oauth/register`, or sends its client ID
   metadata document URL as `client_id`.
4. The owner's browser opens `GET /oauth/authorize` with PKCE S256, `state`,
   `scope` and `resource`. The hub checks the client and the redirect URI
   first. When either is wrong it shows an error page and never redirects.
   Then it checks the rest, saves the request for 10 minutes and sends the
   browser to the web app at `/oauth/consent?request=<id>`.
5. The web app needs the owner signed in (the hub token, or a paired app's
   token, which already holds more than any scope gives). It reads the request with `GET /api/oauth/requests/:id`, which
   also returns a one time consent value. The page shows "<redirect host>
   wants access to your Conclave", the name the app gave itself, and each
   scope in plain words. Allow and Deny post to
   `POST /api/oauth/requests/:id` with the consent value. The hub answers
   with the URL to go back to, carrying `code`, `state` and `iss`, or
   `error=access_denied`. The page then leaves for it.
6. The client posts the code and the PKCE verifier to `POST /oauth/token`.
   It gets an access token (1 hour) and a refresh token (30 days, rotated on
   every use). A client whose document or registration says
   `private_key_jwt` also sends a signed `client_assertion` on every token
   and revocation request (threat 10).
7. Every `/mcp` call carries the access token. The hub checks the token, its
   resource and the scope of each `tools/call`, `prompts/get` and
   `resources/read` before the MCP SDK runs. `tools/list` only shows what the
   token may call.
8. Settings > Connected apps lists each app with consent: name, domain,
   scopes, created and last used, and Revoke. Revoke deletes its tokens and
   its registration.

Scopes:

| Scope | Plain words | Tools |
| --- | --- | --- |
| `memory:read` | Read your memory: your profile, facts, goals, tasks and today's plan | `memory_context`, `memory_search`, `memory_recent`, `tasks_list`, `routines_list`, the `memory_context` prompt and resource |
| `memory:write` | Save new memories and forget old ones | `memory_save`, `memory_forget` |
| `chats:read` | Search your past chats | `sessions_search`, `chat_search` |

The table lives in `packages/server/src/mcp-endpoint.ts` (`MCP_TOOL_SCOPES`).
A tool without a row is hidden from OAuth tokens and refused, so a new tool
stays closed until someone gives it a scope. The hub token, paired app tokens
and gateway keys keep full access, as before.

Storage: six tables made by `packages/server/src/oauth/store.ts` (clients,
pending requests, codes, grants, tokens, and the client assertions already
used). Codes, access tokens, refresh tokens, client secrets and assertion
ids are stored as SHA-256 hashes. A client's public keys are stored as
given. Backups do not include them.

## Threats and the test for each

Tests are in `packages/server/test/oauth.test.ts` unless a line says
otherwise. "Hub error page" means an HTML page on the hub with no `Location`
header.

### 1. A stolen authorization code

Someone copies the code from the redirect, a log or browser history.

- PKCE is required and only S256 is accepted. `plain` and a missing method
  are refused at authorize.
- The code is bound to its client, redirect URI, scope and resource. It
  works once and for 10 minutes.
- A second use of a code revokes every token made from it (RFC 6749
  4.1.2).

Tests: `code: plain PKCE and a missing challenge are refused`,
`code: wrong verifier, other client and other redirect fail`,
`code: works once, and a replay revokes what it made`,
`code: expires after 10 minutes`.

### 2. Redirect tricks and open redirects

Someone makes the hub send a code, or the owner, somewhere else.

- Registration accepts only `https` URIs and `http` on `localhost`,
  `127.0.0.1` or `[::1]`. No fragments, no user info, no other schemes.
- Authorize compares the redirect URI to the registered ones as an exact
  string. Only loopback URIs ignore the port (RFC 8252 section 7.3).
  `localhost` and `127.0.0.1` do not stand in for each other.
- A wrong client or redirect URI gets the hub error page. Errors after that
  go back to the checked URI only.
- Every answer carries `iss`, so a client can tell this hub from another
  (mix-up attacks, RFC 9207).

Tests: `redirect: registration refuses http, javascript, fragments and user
info`, `redirect: near misses are refused without a redirect`,
`redirect: loopback ignores the port and nothing else`,
`redirect: errors after the check carry state and iss`.

### 3. CSRF and clickjacking on the consent screen

Another site makes the owner's browser approve a request.

- The decision is a JSON `POST` that needs the owner's token in the
  `Authorization` header. The web app keeps it in local storage, never in a
  cookie, so another site cannot send it.
- It also needs the consent value that only `GET /api/oauth/requests/:id`
  returns. It is not in the URL, it changes on every read and works for one
  decision.
- A request is decided once and expires after 10 minutes.
- Pages cannot be framed (`X-Frame-Options: DENY`, `frame-ancestors 'none'`).
  CORS on `/api` only allows the hub's own addresses.

Tests: `consent: needs a signed in owner`, `consent: needs the consent value
from this request`, `consent: decides once`, `consent: expires`.

### 4. Tokens and codes in logs

- Tokens, codes and client secrets never go in a log line or the audit log.
  Audit entries name the app and the scopes.
- They are stored hashed. Token answers carry `Cache-Control: no-store`.
- `/mcp` takes tokens from the `Authorization` header only, never from the
  query string.
- `Referrer-Policy: no-referrer` on every response.

Tests: `leaks: no token, code or secret in logs, audit or tables`,
`leaks: query string tokens are refused`.

### 5. Replay

- Codes: see 1.
- Refresh tokens rotate. A refresh token used twice revokes the whole grant,
  including the newest tokens, and goes in the audit log.
- Access tokens last 1 hour. Revoked tokens fail on the next call.

Tests: `refresh: rotates, and reuse revokes the grant`,
`access: expires after an hour`, `revoke: the endpoint and Settings both end access`.

### 6. Scope escalation

- Consent grants a subset of what was asked, never more.
- A refresh can keep or narrow the scope, never widen it.
- A registration's `scope` caps what it may ask for.
- Each call is checked against its scope before the SDK runs, with a `403`
  `insufficient_scope` challenge. `tools/list` hides what the token cannot
  call. Prompts and resources are checked too.
- Tokens are bound to this hub's `/mcp` (RFC 8707). They do not work on
  `/api`, and a `resource` for another server is `invalid_target`.
- A refresh token is not an access token.

Tests: `scope: a read token cannot save`, `scope: consent cannot add scopes`,
`scope: refresh cannot widen`, `scope: registration caps the request`,
`scope: tokens only work on /mcp`, `scope: resource must be this hub`.
In core, `packages/core/test/engine/hub-mcp.test.ts`: `allow hides and
refuses tools`.

### 7. A client with a lookalike name

Anyone can register a client called "Claude".

- The headline is the redirect host, not the name: "evil.example wants
  access to your Conclave". Hosts are shown as punycode, so a Cyrillic
  lookalike reads as `xn--...`.
- The name is shown as what it is: "It calls itself Claude." Control,
  bidi and zero width characters are removed and it is cut to 60
  characters.
- A name that says Claude, Anthropic, ChatGPT or OpenAI while the redirect
  goes elsewhere gets a warning in amber.
- A client that only redirects to loopback gets the warning that any
  program on that computer can use the name.
- A client ID metadata document is named by the host of its URL.

Tests: `names: a brand name on another host is flagged`,
`names: hidden characters are removed`, `names: loopback clients are flagged`.

### 8. More ways in

- Registration floods: 60 registrations per address in 10 minutes, at most
  200 registrations that never got consent, and those go after 24 hours.
  Test: `register: rate limit and cleanup`.
- Fetching a client ID metadata document is a request to a URL a stranger
  picks. Only `https` on port 443, never a private, loopback or link-local
  address (checked after DNS), no redirects, 5 seconds, 64 KB, and the
  document's `client_id` must equal its URL. Test: `cimd: refuses private
  addresses, redirects and a wrong client_id`. A `jwks_uri` is fetched with
  the same fences (threat 10).
- Guessing tokens, codes or refresh tokens: wrong tokens at `/mcp` and wrong
  codes and refresh tokens at `/oauth/token` count in the same failure guard
  as wrong hub tokens (20 different ones in 10 minutes block the address).
  Test: `guard: wrong tokens and codes block the address`.
- Plain http: authorize, token and consent refuse plain http unless the
  address is this computer. Test: `http: refused on a network address`.
- Token passthrough: `/mcp` only takes tokens this hub issued for itself and
  never passes a client's token on.

### 9. Consent phishing

Someone adds your hub to their own claude.ai account, copies the sign in
link and sends it to you. If you press Allow, their account could get the
connection.

- The headline names where the answer goes, and the page says: "Only allow
  this if you started connecting it yourself just now."
- Requests last 10 minutes and are decided once.
- claude.ai and ChatGPT bind `state` to the browser session that started the
  sign in, which stops this on their side.

Covered by the consent copy in `packages/web/src/features/connect/ConsentPage.tsx`,
checked in the screenshots, and by `consent: expires` and `consent: decides
once`.

### 10. A forged or reused client assertion (private_key_jwt)

A client whose document or registration says `private_key_jwt` proves who
it is with a JWT signed by its private key (RFC 7523). Someone with a
stolen code or refresh token, but not the key, must not get tokens.

- The client must send `client_assertion_type`
  `urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a
  `client_assertion` on every token and revocation request. Without it, or
  with a bad one, the answer is `401 invalid_client`. The code or refresh
  token is not spent.
- Signature: RS256, PS256 or ES256 only, with a key from the client's own
  key set. `none` and the HMAC algorithms are refused. Keys named in the JWT
  header (`jwk`, `jku`, `x5u`) are never used. RSA keys need 2048 bits. A
  key set that holds a private or shared key is refused whole. If the
  document names `token_endpoint_auth_signing_alg`, the JWT must use it.
- `kid` picks the key. Without one, each key that fits the algorithm is
  tried.
- `iss` and `sub` must both be the `client_id`. `aud` must be the hub's
  issuer, its token endpoint, or the endpoint called, on one of the hub's
  own addresses: its tunnels, `server.publicUrl`, or the address a request
  on this computer used. ChatGPT signs for every server with one key, so an
  assertion made for another server must not pass here. An
  `X-Forwarded-Host` header cannot make another server's address count as
  the hub's.
- `exp` is required and may be at most an hour ahead. `iat` may not be in
  the future or more than an hour back. `nbf` may not be in the future. All
  allow 60 seconds of clock skew. An hour is Okta's and Google's cap, and
  Python's Authlib signs for an hour by default. ChatGPT does not publish
  its lifetime.
- `jti` is required. Each one works once per client: a hash is kept until
  the assertion expires, in the database, so a restart does not forget it.
  A second use is refused and goes in the audit log.
- Keys at a `jwks_uri` are fetched when needed and kept 5 minutes. The fetch
  has the same fences as a client document: https on port 443, public
  addresses only after DNS, no redirects, 5 seconds, 64 KB. A literal
  private address is refused when the document is read. An unknown `kid`
  fetches the keys once more, at most once a minute per URL, so made up
  kids cannot make the hub hammer it. A fetch that failed is not tried
  again for a minute. Inline keys come from the document;
  an unknown `kid` reads the document again, at most once a minute.
- A client the hub knows as public (`none`) or by a client secret that
  sends a `client_assertion` is refused, not waved through. The app and the
  hub then disagree about how it signs in, and an error says so.
- A document still may not name `client_secret_*` or any other method, and
  may not hold a client secret.

Tests are in `packages/server/test/oauth-jwt.test.ts`: `jwt: RS256 with
keys at a jwks_uri, through the code, refreshes and revoke`, `jwt: ES256
and PS256 with keys inline in the document`, `jwt: a missing or bad
assertion is invalid_client, and the code is not spent`, `jwt: an assertion
works once`, `jwt: an unknown kid fetches the keys again, at most once a
minute`, `jwt: keys on a private address, behind a redirect or with a
private key are never used`, `cimd: a document that asks for a client
secret, or gives no usable keys, is still refused`, `none: a public client
known by a document URL works as before, and an assertion from it is
refused`, `dcr: an app can register for private_key_jwt with its jwks_uri`,
`jwt: aud must be one of the hub’s own addresses, not one a request header
names`, and the checks under `assertion checks`.

## Where it can fail

- Claude and ChatGPT reach the hub from their own servers. A quick tunnel
  address changes on restart, which breaks the connector until it is added
  again. Use the stable tunnel or your own URL.
- Many people share Anthropic's and OpenAI's egress addresses. Twenty
  different wrong tokens from one of them block it for a minute, for
  everyone using that address with this hub.
- A refresh retried after a lost answer looks like reuse and ends the grant.
  The app then asks to connect again.
- Registrations from claude.ai pile up, one per fresh connection. Unused ones
  go after a day. Revoke removes the rest.
- Redirect URIs match exactly. If a client's metadata document leaves out
  the redirect URI it then uses (one report says ChatGPT did this once), the
  hub shows its error page and the sign in stops. The hub does not loosen
  the match for it.
- The address check for a client metadata document runs before the fetch. A
  DNS answer that changes between the check and the fetch (rebinding) is not
  caught. The fetch only reads JSON and shows a name, so the most it can do
  is make the hub send one GET.
- A paired app's token can answer the consent page, as the hub token can.
- A hub behind a proxy it was not told about knows no https address of its
  own. Then it takes the address a request names as an `aud`, so ChatGPT
  still works, and threat 10's header guard is off. Setting
  `server.publicUrl` turns it on.
- A `private_key_jwt` client must sign every token request. If ChatGPT
  ever sends none while its document says `private_key_jwt`, the sign in
  stops at the token step with `invalid_client`.
