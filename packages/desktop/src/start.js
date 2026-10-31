// What the start page does when the saved hub does not open (main.js), kept
// apart so `bun test packages/desktop/test` can check it. At login the app
// often starts before the network is up: a saved hub and token then wait and
// try again, and only the hub turning the token away asks to sign in.

/** The words hub.rs REJECTED gives for a 401 or 403 from the hub. */
const REJECTED = 'The hub rejected this token or code.';

/**
 * After open_hub failed on start: "retry" stays on the Connecting screen,
 * "form" shows the sign-in form. `s` is get_settings' reply.
 */
function afterOpenFailed(s, err) {
  if (!s.hubUrl || !s.hasToken) return 'form';
  return String(err).includes(REJECTED) ? 'form' : 'retry';
}

/** Milliseconds before try `n` again (0 first): 1, 2, 4, 8 s, then every 15 s. */
function retryDelay(n) {
  return n < 4 ? 1000 * 2 ** n : 15_000;
}

if (typeof module !== 'undefined') module.exports = { afterOpenFailed, retryDelay };
