/*
 * The relay page (index.html): read what Google sent, name the hub it goes
 * back to, and go there only when the owner presses Continue. The rules are
 * in relay.js.
 */
import { relayTarget } from './relay.js';

const $ = (id) => document.getElementById(id);
const t = relayTarget(location.search);

// the code stays out of this tab's history and out of an address someone copies from here
try {
  history.replaceState(null, '', location.pathname);
} catch (e) {
  /* nothing to tidy */
}

if (t.href) {
  for (const el of document.querySelectorAll('[data-host]')) el.textContent = t.host;
  $('origin').textContent = t.origin;
  $('go').href = t.href;
  if (t.error) {
    $('said').textContent = t.error === 'access_denied' ? 'You cancelled the sign-in at Google.' : `Google did not finish the sign-in (${t.error}).`;
    $('next').textContent = 'Continue tells your Conclave hub, at this address:';
  }
  $('ok').hidden = false;
} else {
  $('bad').hidden = false;
}
$('wait').hidden = true;
