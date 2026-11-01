/**
 * The OAuth apps Conclave ships with (docs/design/OAUTH-APPS.md). The project
 * owner registers one app per provider and pastes its ids here; then
 * Settings shows a plain "Sign in with Google" or "Sign in with Microsoft"
 * with no setup steps. Empty values mean no shared app yet: each hub
 * registers its own, or overrides these in Settings > Calendar and mail.
 *
 * Nothing here is a secret in the OAuth sense. Google treats the secret of a
 * Desktop app client as public (installed apps cannot keep one), and the
 * iOS, Android and Microsoft public clients have no secret at all. PKCE
 * protects every sign-in. The shared Web application client's secret ships
 * for the same reason: its only redirect is the relay page below, every
 * sign-in with it uses PKCE, and the verifier never leaves the hub
 * (docs/design/OAUTH-APPS.md, "The relay").
 */
export interface ShippedOAuthClients {
  google: {
    /** Desktop app client: loopback redirect from the desktop app or a browser on the hub machine. */
    desktop: { clientId: string; clientSecret: string };
    /**
     * Web application client whose one redirect URI is GOOGLE_RELAY_URL. Google
     * sends the browser to the relay page, which hands the code back to the hub
     * the sign-in started on. Empty: no relay, and sign-in works as before.
     */
    web: { clientId: string; clientSecret: string };
    /** iOS client: the phone signs in through the system browser and the app's custom scheme. */
    ios: { clientId: string };
    /** Android client: the same on Android (custom scheme enabled in its advanced settings). */
    android: { clientId: string };
  };
  microsoft: {
    /** Multi-tenant public client with the device code flow on (personal and work accounts). */
    clientId: string;
  };
}

/**
 * The relay page on the project site (site/oauth/google/): the shared Web
 * client's only Authorized redirect URI, exactly as registered at Google,
 * trailing slash included.
 */
export const GOOGLE_RELAY_URL = 'https://conclave.kaivalyaahir.com/oauth/google/';

export const OAUTH_CLIENTS: ShippedOAuthClients = {
  google: {
    // the shared Desktop app client; Google treats its secret as public, so it ships here and only here
    desktop: { clientId: '318321774791-c5r0egg9h4d8bthklvjpq5804u3cki2n.apps.googleusercontent.com', clientSecret: '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' },
    // the shared Web application client behind the relay; the owner pastes its id and secret here (docs/design/OAUTH-APPS.md)
    web: { clientId: '318321774791-06cf2q3c4b6rulolhh192av5tggi7v02.apps.googleusercontent.com', clientSecret: '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' },
    // the iOS app's redirect scheme is this id reversed: com.googleusercontent.apps.318321774791-q1ql9qqdrrq0vnfmt666s4vlvshpjt5e
    ios: { clientId: '318321774791-q1ql9qqdrrq0vnfmt666s4vlvshpjt5e.apps.googleusercontent.com' },
    android: { clientId: '' },
  },
  // the shared Entra app comes later
  microsoft: { clientId: '' },
};
