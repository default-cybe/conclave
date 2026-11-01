# The shared OAuth apps

For the project owner. Conclave is self-hosted, so it has no server of its
own that could hold a Google or Microsoft app. To let owners sign in with a
plain "Sign in with Google" or "Sign in with Microsoft", like claude.ai's
connectors, the project registers one app per provider once and its client
ids ship in `packages/core/src/mail/oauth-clients.ts` (`OAUTH_CLIENTS`). A
hub can still use its own app instead: Settings, Calendar and mail, "Use
your own Google app" or "Use your own Microsoft app". How the hub uses the
clients is in `docs/DESIGN.md`, section 32.

Nothing secret ships. Google treats the secret of a Desktop app client as
public, because an installed app cannot keep one; the iOS, Android and
Microsoft clients are public clients without a secret. The shared Web
application client behind the relay ships its secret too, for the reasons
in "The relay" below. Every Google sign-in uses PKCE, and the hub keeps the
refresh tokens.

## Where things stand

- Google project with the consent screen **In production, unverified**:
  Google shows its "unverified app" warning, and the app is capped at 100
  users over its lifetime until it is verified. Home page
  https://conclave.dymnitguys.com, privacy policy
  https://conclave.dymnitguys.com/privacy.html.
  The site moved there from conclave.kaivalyaahir.com, which now answers
  with a 301 to the same path and query on the new domain.
- `google.desktop`: filled in (client id and its public secret).
- `google.web`: empty, until the owner creates the Web client in step 5
  below. While it is empty the relay is off and sign-in works as before
  (loopback, or the 127.0.0.1 address pasted back). The relay page is
  `site/oauth/google/`, served at https://conclave.dymnitguys.com/oauth/google/
  once the site deploys from main. Its registered redirect URI stays
  https://conclave.kaivalyaahir.com/oauth/google/ (step 5), which redirects
  there with the query kept.
- `google.ios`: filled in. The iOS app registers the reversed client id,
  `com.googleusercontent.apps.318321774791-q1ql9qqdrrq0vnfmt666s4vlvshpjt5e`,
  as a URL scheme (`packages/mobile`, `add:ios`). The in-app sign-in on the
  iPhone is not built yet; the hub side is (`client: "ios"`).
- `google.android`: empty.
- `microsoft`: empty, until the Entra app below exists.

## Google: one-time steps

1. **Project.** console.cloud.google.com, New project, "Conclave".
2. **APIs.** APIs and services, Library: enable the **Gmail API** and the
   **Google Calendar API**.
3. **Consent screen** (Google Auth platform, Branding and Audience):
   - User type **External**.
   - App name "Conclave", support email, the home page and privacy policy
     above, an authorized domain for them.
   - Data access (scopes): `openid`, `email`,
     `https://www.googleapis.com/auth/gmail.readonly`,
     `https://www.googleapis.com/auth/gmail.compose`,
     `https://www.googleapis.com/auth/calendar.readonly`,
     `https://www.googleapis.com/auth/calendar.events`.
     The Gmail scopes are **restricted**, the Calendar ones **sensitive**.
   - Publishing status: **In production**. In Testing, refresh tokens
     expire after 7 days and only listed test users can sign in. In
     production without verification, anyone can sign in after the warning
     screen, up to the 100 user cap.
4. **Desktop client.** Clients, Create client, type **Desktop app**, name
   "Conclave desktop". Google allows any loopback port for this type, which
   the hub (`http://127.0.0.1:<port>/api/pim/oauth/google/callback`) and the
   desktop app both use. Copy the client id and the secret.
5. **Web client (the relay).** In the same project, Clients, Create client,
   type **Web application**, name "Conclave relay".
   - Authorized JavaScript origins: none.
   - Authorized redirect URIs: exactly
     `https://conclave.kaivalyaahir.com/oauth/google/`, with the trailing
     slash. Nothing else: this one address is what makes shipping the
     secret safe.
   - Branding, Authorized domains must list the domain of this redirect
     URI. Google takes the top private domain, `kaivalyaahir.com`, which
     covers `conclave.kaivalyaahir.com`. Keep it listed next to
     `dymnitguys.com`, the domain of the home page and privacy policy in
     step 3.
   - Copy the client id and the secret.
6. **iOS client.** Create client, type **iOS**, bundle id of the iPhone app
   (the one in `packages/mobile/capacitor.config.ts`). Copy the client id.
   Its redirect is `com.googleusercontent.apps.<id without the suffix>:/oauth2redirect`;
   the reversed id must be a URL scheme in the app's Info.plist.
7. **Android client** (later). Create client, type **Android**, package
   name and the SHA-1 of the signing key. Google turned custom URI schemes
   off for new Android clients: turn it on under the client's Advanced
   settings, or the phone cannot get the redirect back.

Paste into `packages/core/src/mail/oauth-clients.ts`:

```ts
export const OAUTH_CLIENTS: ShippedOAuthClients = {
  google: {
    desktop: { clientId: '<desktop client id>', clientSecret: '<desktop client secret>' },
    web: { clientId: '<web client id>', clientSecret: '<web client secret>' },
    ios: { clientId: '<ios client id>' },
    android: { clientId: '<android client id>' },
  },
  microsoft: { clientId: '<application (client) id>' },
};
```

The relay turns on by itself once `web` has both values; the next release
carries it to every hub. The desktop and web secrets go only in that file:
not in tests (they use fake values), docs, logs or screenshots.

## The relay

A self-hosted hub often has no https address: it answers at
`http://192.168.1.20:7777` on the home network, or at `127.0.0.1`. Google
sends a sign-in back only to https or to loopback, so before the relay a
browser away from the hub machine could only finish by pasting the
`127.0.0.1` address back. The relay is a static page on the project site
that hands the code to whichever hub started the sign-in.

1. Settings sends the hub address the page uses (its `location.origin`;
   in the phone app, whose page is `capacitor://localhost`, the hub
   address it talks to) to `POST /api/pim/oauth/google/start` with
   `client: "relay"`. The hub accepts it only when it is one of its own
   addresses (tunnels, own URL, the same network, `server.publicUrl`) or
   the origin of that request, and only as `http` or `https` with nothing
   after the host.
2. The hub signs in with the shared Web client: `redirect_uri` is the
   relay page, PKCE S256 as always, and the state is
   `<random flow id>.<base64url of <hub origin>/api/pim/oauth/google/callback>`.
   The flow keeps the verifier and the relay `redirect_uri` for the
   exchange.
3. Google sends the browser to the relay page with `code` and `state` (or
   `error`). The page (`site/oauth/google/relay.js`) reads the return
   address from the state and accepts it only when it is exactly an
   `http` or `https` origin followed by `/api/pim/oauth/google/callback`:
   no other path, query or fragment, no user name or password, no other
   scheme. It shows "Finish signing in to Conclave at <host>" and goes
   there only when the owner presses **Continue**, carrying `state` and
   `code` (or `error`) and nothing else.
4. The hub's public callback finishes it as before: an unknown or expired
   state is refused; a known one exchanges the code with the shared Web
   client id and secret, the verifier and the relay `redirect_uri`. The
   account remembers `client: "relay"`, so refreshes use the same client.

Which way Settings starts a Google sign-in, in order: the hub's own Web
client at its https address; else the relay, when `google.web` is set;
else loopback on the hub machine; else loopback with the address pasted
back. The sentence under Sign in with Google says which one happens, and
no setup steps show while the relay is there.

Why shipping the Web client's secret is acceptable here:

- **The redirect is fixed.** Google sends codes for this client only to
  the one registered redirect URI, the relay page. Someone holding the id
  and secret cannot have Google send a code to their own server.
- **PKCE on every sign-in.** A code is worth nothing without the verifier,
  and the verifier never leaves the hub that started the sign-in. A code
  read from the relay page's address, a log or the browser history cannot
  be exchanged by anyone else, and Google takes each code once, for a few
  minutes.
- **The relay asks before it forwards.** It shows the host it will send
  the browser to and waits for a click, so it cannot be used as a silent
  redirect that delivers a code to an address the owner never sees. It
  sends nowhere but the exact callback path on an http or https origin.
- **The same risk as the Desktop client.** The Desktop client's id and
  secret already ship and Google treats them as public; any program can
  use them with a loopback redirect. What an attacker could do with the
  Web client (show Google's consent screen with the name "Conclave") they
  can already do with the Desktop client. The refresh tokens stay on each
  hub, as before.
- **The page keeps nothing.** No cookies, storage, analytics or scripts
  from elsewhere; a Content Security Policy that allows only its own
  files; `no-referrer`, so the hub address and code are not sent onwards;
  and it takes the code out of the tab's address and history at once.
  GitHub Pages may log the page's address, which holds the code: harmless
  for the reasons above.

If the secret is ever abused, reset it in Google Cloud and ship the new one
in a release; hubs on older releases get Google's `invalid_client` at the
end of a relayed sign-in until they update. Where it can fail: the browser must reach the
hub at the address the page used (a phone off the home network cannot
reach `http://192.168.1.20:7777`), and a browser may one day ask before a
public page sends it to a local address.

## Microsoft: one-time steps

1. entra.microsoft.com, App registrations, **New registration**, name
   "Conclave", supported account types **Accounts in any organizational
   directory and personal Microsoft accounts** (multi-tenant, so Outlook.com
   and work accounts both work). No redirect URI.
2. **Authentication**: Advanced settings, **Allow public client flows: Yes**.
   This turns on the device code flow. No secret, no certificate.
3. **API permissions**, Microsoft Graph, Delegated: `Mail.Read`,
   `Mail.ReadWrite` (drafts), `Mail.Send` (sending), `offline_access`,
   `openid`, `email`, `profile`. No admin consent is needed for these; a
   work tenant may still require an admin to allow the app.
4. Branding: name, logo, the home page and privacy policy above. A verified
   publisher (Microsoft Partner Network id) removes the "unverified" label
   on the consent page; without it, work tenants that only allow verified
   publishers block the app.
5. Paste the **Application (client) id** into `microsoft.clientId`.

## Lifting Google's 100 user cap and the warning screen

The app needs Google's verification. Sensitive scopes (Calendar) need brand
and scope verification only. Restricted scopes (Gmail) also need a security
assessment every 12 months.

1. **Brand verification**: a verified home page on a domain you own, a
   privacy policy that says what Gmail and Calendar data the app reads, that
   it stays on the owner's own hub, and how to delete it. A few days.
2. **Scope justification**: for each scope, why the app needs it and a
   short screen recording of the sign-in and of the feature using it. Ask
   for the narrowest scopes: `gmail.readonly` and `gmail.compose` (never
   full `mail.google.com`), `calendar.readonly` and `calendar.events`.
   Google's Limited Use rules apply: no ads, no selling data, no humans
   reading mail.
3. **Security assessment (CASA)** for the restricted Gmail scopes: an
   assessment by a Google-approved lab under the App Defense Alliance's
   Cloud Application Security Assessment, usually Tier 2. Reported costs
   range from a few hundred to a few thousand US dollars a year for Tier 2;
   the review takes a few weeks; it repeats every 12 months.
4. Until it passes, keep the app In production and unverified, with the
   warning screen and the cap. The 100 counts every user who ever signed in
   and cannot be reset.

A self-hosted project fits awkwardly: the hub runs on each owner's machine,
so the assessment covers the code, not a server. If verification is not
worth it, the cap stays, and owners beyond 100 add their own Google app in
Settings (the steps are on the page); their own app in Testing works for
them alone, with 7 day refresh tokens, or in production unverified like
this one.

Sources for the assessment figures (vendor pages, so indicative only):
docs.nango.dev/integrations/google-security-review,
developer.nylas.com/docs/cookbook/use-cases/build/google-oauth-scopes/,
unipile.com/integrating-google-oauth-2-0-user-authentication-into-your-app/.
