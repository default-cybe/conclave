// Connection page and the app's own settings. It asks for the hub URL and a
// pairing code, a sign-in name or email and a password, or a token, or runs
// the hub on this computer, then hands off to the Rust side
// (src-tauri/src/main.rs), which checks the hub, stores the token and loads
// the hub's web UI in this window.
//
// Password is the web app's (packages/web/src/features/connect/ConnectForm.tsx,
// docs/design/HUB-LOGIN-AND-IDENTITY.md): the "Sign-in name or email" field
// shows when the hub has more than one person, and a password login has no
// code to check the hub against, so its fingerprint shows before anything is
// kept. The password goes to the Rust side for that one request and is
// cleared here.
//
// "Let the hub use this computer" is on the same form, on by default the
// first time, so one press pairs the app and turns on the daemon the app
// carries (src-tauri/src/computer.rs). "Run the hub on this computer" starts
// a hub here instead (src-tauri/src/local.rs): the app downloads it, runs it,
// and signs in to it with no code. ?settings=1 shows both switches again,
// with their state, for turning them off or on later; &pair=1 opens the
// phone pairing code. Settings also has the `conclave` command in a terminal
// (src-tauri/src/terminal.rs), with Remove and Reinstall.
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let settings = null;
/** What the main button says when it is not busy. */
let idleLabel = 'Connect';
/** "connect" or "local": which of the two the form does. */
let mode = 'connect';
/** "code", "password" or "token": how Connect signs in to the hub. */
let way = 'code';
/** The hub has more than one person: the password login asks whose. */
let people = false;
/** The owner changed Start at login on the form by hand. */
let autostartTouched = false;

function showError(message, id = 'error') {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function showOnly(id) {
  for (const part of ['connecting', 'starting', 'form', 'check', 'settings']) $(part).hidden = part !== id;
}

function showForm() {
  showOnly('form');
}

/** false, or the words to show on the button while it works. */
function setBusy(words) {
  $('connect').disabled = !!words;
  $('connect').textContent = words || idleLabel;
  for (const input of document.querySelectorAll('input[name="mode"], input[name="way"]')) input.disabled = !!words;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The hub on this computer
// ---------------------------------------------------------------------------

/** The button's words while the hub gets ready. */
function busyWords(v, share) {
  switch (v.phase) {
    case 'getting':
      return v.total ? `Downloading ${Math.floor((v.done * 100) / v.total)}%…` : 'Downloading…';
    case 'unpacking':
      return 'Unpacking…';
    case 'connecting':
      return share ? 'Setting up this computer…' : 'Connecting…';
    case 'waiting':
      return 'Waiting…';
    case 'retrying':
      return 'Trying again…';
    default:
      return 'Starting the hub…';
  }
}

/** Follow the hub until it runs, fails or is off. `tick` sees each state. */
async function followHub(tick) {
  for (;;) {
    const v = await invoke('local_hub_status');
    tick(v);
    if (v.phase === 'running' || v.phase === 'failed' || (v.phase === 'off' && !v.on)) return v;
    await sleep(400);
  }
}

async function startLocal() {
  showError('');
  $('open-anyway').hidden = true;
  setBusy('Starting…');
  const share = settings.daemon && $('computer').checked;
  try {
    if (settings.daemon && !share && settings.computer !== false) {
      // the owner turned it off here: the Rust side removes a daemon it set up before
      await invoke('computer_disable').catch(() => {});
    }
    // on by default for a hub here: phones and routines need it up after login.
    // It does not hold the hub back: Settings shows the box as it ended up.
    if ($('autostart').checked && !settings.autostart) {
      try {
        await invoke('set_autostart', { enabled: true });
        settings.autostart = true;
      } catch {
        $('autostart').checked = false;
      }
    }
    await invoke('local_hub_set', { on: true, computer: share });
  } catch (err) {
    showError(String(err));
    setBusy(false);
    return;
  }
  settings.runHub = true;
  $('local-state').hidden = false;
  const v = await followHub((v) => {
    setBusy(busyWords(v, share));
    $('local-state').textContent = v.words;
  });
  if (v.phase !== 'running') {
    $('local-state').hidden = true;
    showError(v.words);
    idleLabel = 'Try again';
    setBusy(false);
    return;
  }
  if (v.computerError) {
    showError(`The hub runs. It cannot use this computer yet. ${v.computerError}`);
    idleLabel = 'Try again';
    $('open-anyway').hidden = false;
    setBusy(false);
    return;
  }
  setBusy('Opening…');
  try {
    await invoke('open_hub');
  } catch (err) {
    showError(String(err));
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Connect to a hub
// ---------------------------------------------------------------------------

async function connect() {
  showError('');
  $('open-anyway').hidden = true;
  setBusy('Connecting…');
  try {
    // alt: the hub's other addresses from a pairing link, tried when the first does not answer.
    // open: false, so the daemon is set up before the hub loads in this window.
    // A hub this computer runs stops first (the Rust side does it).
    await invoke('connect', { hubUrl: $('hub').value, credential: way === 'password' ? '' : $('credential').value, alts: params.getAll('alt'), open: false });
  } catch (err) {
    showError(String(err));
    setBusy(false);
    return;
  }
  await connected();
}

/** A saved token can be used again: an empty code, token or password keeps it. */
function keepsSaved() {
  return settings.hasToken && !settings.runHub;
}

function placeholders() {
  const keep = keepsSaved() ? 'Empty keeps the saved token' : '';
  $('credential').placeholder = keep || (way === 'token' ? 'cnc_' : 'e.g. 4F7K-92QD');
  $('password').placeholder = keep;
}

/** Log in with the sign-in name or email and password, then show the hub's fingerprint before anything is kept. */
async function login() {
  showError('');
  $('open-anyway').hidden = true;
  const password = $('password').value;
  if (!password) {
    // a retry after a login that was kept (Try again): the saved token, as an empty code does
    if (keepsSaved()) return connect();
    showError('Enter the password.');
    $('password').focus();
    return;
  }
  setBusy('Logging in…');
  // the address may have changed just now: ask again whether the hub has several people
  await checkPeople(true);
  const account = people ? $('account').value.trim() : '';
  if (people && !account) {
    showError('Enter your sign-in name or email.');
    setBusy(false);
    $('account').focus();
    return;
  }
  let check;
  try {
    check = await invoke('login', { hubUrl: $('hub').value, account: account || null, password });
  } catch (err) {
    showError(String(err));
    setBusy(false);
    return;
  } finally {
    // never kept on this page: a new try asks for it again
    $('password').value = '';
    showPassword(false);
  }
  // a hub from before hub identity sends no fingerprint: nothing to compare, as on the web
  if (!check.fingerprint) return keepLogin();
  const who = check.account ? ` as ${check.account}` : '';
  $('check-title').textContent = check.hubName ? `Logged in to ${check.hubName}${who}` : `Logged in${who}`;
  const groups = check.fingerprint.split(' ');
  $('check-fp').replaceChildren(
    ...groups.map((g) => {
      const span = document.createElement('span');
      span.textContent = g;
      return span;
    }),
  );
  $('check-fp').setAttribute('aria-label', `Fingerprint ${check.fingerprint}`);
  showOnly('check');
  $('check-continue').focus();
}

/** Continue: the Rust side keeps the login's token, then the same steps as after pairing. */
async function keepLogin() {
  showForm();
  setBusy('Connecting…');
  try {
    await invoke('login_confirm', { open: false });
  } catch (err) {
    showError(String(err));
    setBusy(false);
    return;
  }
  await connected();
}

$('check-continue').addEventListener('click', keepLogin);

$('check-cancel').addEventListener('click', async () => {
  // the Rust side signs that login out on the hub and keeps nothing
  await invoke('login_cancel').catch(() => {});
  showForm();
  setBusy(false);
  showError('Nothing was kept. Check the hub address with its owner.');
  $('hub').focus();
});

function showPassword(on) {
  $('password').type = on ? 'text' : 'password';
  $('password-show').textContent = on ? 'Hide' : 'Show';
  $('password-show').setAttribute('aria-pressed', String(on));
}

$('password-show').addEventListener('click', () => showPassword($('password').type === 'password'));

let peopleTimer = 0;

/**
 * Ask the hub whether it has more than one person (GET /api/health), once
 * the address settles: then the password login asks whose password it is.
 * `now`: ask at once and wait for the answer. A hub that does not answer
 * leaves the field as it was; the login then says why.
 */
function checkPeople(now = false) {
  clearTimeout(peopleTimer);
  if (way !== 'password') return Promise.resolve();
  const url = $('hub').value.trim();
  const ask = async () => {
    if (!url) return;
    let many;
    try {
      many = await invoke('hub_people', { hubUrl: url });
    } catch {
      return;
    }
    // the address changed while it asked: the newer check decides
    if ($('hub').value.trim() === url && way === 'password') setPeople(!!many);
  };
  if (now) return ask();
  peopleTimer = setTimeout(ask, 300);
  return Promise.resolve();
}

function setPeople(many) {
  people = many;
  $('account-field').hidden = !many || way !== 'password';
}

$('hub').addEventListener('input', () => checkPeople());

/** Saved: the same steps after a code, a token or a password. */
async function connected() {
  const share = settings.daemon && $('computer').checked;
  settings.runHub = false;
  settings.hasToken = true;
  $('connect-stops').hidden = true;
  // paired: a retry uses the saved token, the code is spent
  $('credential').value = '';
  placeholders();
  if (settings.daemon) {
    if (share) {
      setBusy('Setting up this computer…');
      try {
        await invoke('computer_enable');
      } catch (err) {
        showError(`Connected. The hub cannot use this computer yet. ${err}`);
        // Try again sets up this computer again; Open Conclave goes on without it
        idleLabel = 'Try again';
        $('open-anyway').hidden = false;
        setBusy(false);
        return;
      }
    } else if (settings.computer !== false) {
      // the owner turned it off here: say so to the Rust side (it removes a daemon it set up before)
      await invoke('computer_disable').catch(() => {});
    }
  }
  setBusy('Opening…');
  try {
    await invoke('open_hub');
  } catch (err) {
    showError(String(err));
    setBusy(false);
  }
}

/** Show the fields of one of the two ways. */
function setMode(next) {
  mode = next;
  const local = next === 'local';
  for (const input of document.querySelectorAll('input[name="mode"]')) input.checked = input.value === next;
  $('connect-fields').hidden = local;
  $('hub').required = !local;
  $('local-fields').hidden = !local;
  $('autostart-hint').hidden = !local;
  $('connect-stops').hidden = local || !settings.runHub;
  $('local-state').hidden = true;
  // a hub here should be up after login; on by default unless the owner says otherwise
  if (!autostartTouched) $('autostart').checked = local || settings.autostart;
  idleLabel = local ? 'Start the hub' : way === 'password' ? 'Log in' : 'Connect';
  showError('');
  $('open-anyway').hidden = true;
  setBusy(false);
}

/** Show the fields of one way to sign in to the hub: a pairing code, a name and password, or a token. */
function setWay(next) {
  way = next;
  const password = next === 'password';
  for (const input of document.querySelectorAll('input[name="way"]')) input.checked = input.value === next;
  $('credential-field').hidden = password;
  $('credential-label').textContent = next === 'token' ? 'Token' : 'Pairing code';
  $('code-hint').hidden = next !== 'code';
  $('token-hint').hidden = next !== 'token';
  $('hub-hint').hidden = !password;
  $('password-field').hidden = !password;
  setPeople(people);
  placeholders();
  if (mode === 'connect') idleLabel = password ? 'Log in' : 'Connect';
  showError('');
  $('open-anyway').hidden = true;
  setBusy(false);
  checkPeople();
}

// ---------------------------------------------------------------------------
// Settings (?settings=1)
// ---------------------------------------------------------------------------

function setState(words) {
  $('s-state').textContent = words;
}

async function refreshComputer() {
  setState('Checking…');
  try {
    const v = await invoke('computer_status');
    $('s-computer').checked = v.enabled;
    setState(v.words);
  } catch (err) {
    setState('');
    showError(String(err), 's-error');
  }
}

/** The hub row, the Back button and the phones block follow the connection. */
function showConnection() {
  const s = settings;
  // the address of a hub here is in the state line under its switch
  $('s-hub').textContent = s.runHub ? 'This computer' : s.hubUrl || 'Not connected';
  $('s-hub').classList.toggle('mono', !s.runHub && !!s.hubUrl);
  $('s-back').hidden = !s.hasToken;
  $('s-phones').hidden = !s.hasToken;
  $('s-autostart-hint').hidden = !s.runHub;
  const box = $('s-computer');
  box.disabled = !s.hasToken || (!s.daemon && s.computer !== true);
  $('s-local-hint').textContent =
    !s.runHub && s.hasToken && s.hubUrl
      ? `Chats, keys and routines live here. The app then uses it instead of ${s.hubUrl}.`
      : 'Chats, keys and routines live here. Phones and routines need this computer on.';
}

let localTimer = null;
let lastPhase = null;

/** The hub switch's state line, followed every second while something happens. */
async function refreshLocal() {
  clearTimeout(localTimer);
  let v;
  try {
    v = await invoke('local_hub_status');
  } catch (err) {
    $('s-local-state').textContent = String(err);
    return;
  }
  const box = $('s-local');
  if (!box.disabled) box.checked = v.on;
  const words = v.computerError ? `${v.words} The hub cannot use this computer yet. ${v.computerError}` : v.words;
  $('s-local-state').textContent = v.on || v.phase !== 'off' ? words : '';
  $('s-local-state').hidden = !$('s-local-state').textContent;
  $('s-local-links').hidden = !v.on;
  // the app's own hub only: one it found running (conclave serve) keeps its own settings
  $('s-lan-row').hidden = !v.on || !!settings?.hubAdopted || !!v.external;
  $('s-lan').checked = !!settings?.hubLan;
  $('s-retry').hidden = !['failed', 'retrying', 'waiting'].includes(v.phase);
  const settled = v.phase === 'running' || v.phase === 'failed' || (v.phase === 'off' && !v.on);
  if (v.phase === 'running' && lastPhase !== null && lastPhase !== 'running') {
    // the app just connected to it (and paired this computer): the rest of the page follows
    settings = await invoke('get_settings');
    showConnection();
    refreshComputer();
  }
  lastPhase = v.phase;
  if (!$('settings').hidden) localTimer = setTimeout(refreshLocal, settled ? 4000 : 800);
}

/** This app's version and its update (src-tauri/src/update.rs): "Update to X and restart" when there is one. */
async function refreshUpdate() {
  let v;
  try {
    v = await invoke('update_status');
  } catch {
    $('s-update').hidden = true;
    return;
  }
  $('s-version').textContent = v.current;
  const words = v.installing
    ? 'Downloading and installing. Conclave restarts by itself.'
    : v.available
      ? `Conclave ${v.available} is ready.`
      : v.off
        ? 'Updates from the app are off here.'
        : v.error
          ? 'Could not check for updates. It tries again in 15 minutes.'
          : 'This is the newest version.';
  $('s-update-state').textContent = words;
  $('s-update-links').hidden = !v.available || v.installing;
  $('s-update-now').textContent = v.available ? `Update to ${v.available} and restart` : '';
  $('s-update-auto').checked = settings?.autoUpdate !== false;
  $('s-update-auto').disabled = !!v.off;
}

$('s-update-auto').addEventListener('change', async (event) => {
  const box = event.target;
  try {
    await invoke('update_auto', { on: box.checked });
    settings.autoUpdate = box.checked;
  } catch (err) {
    box.checked = !box.checked;
    showError(String(err), 's-error');
  }
});

/** `words` with `code` in backticks: text nodes and <code> elements, nothing read as HTML. */
function setWords(el, words) {
  el.replaceChildren(
    ...String(words || '')
      .split('`')
      .map((part, i) => {
        if (i % 2 === 0) return document.createTextNode(part);
        const code = document.createElement('code');
        code.textContent = part;
        return code;
      }),
  );
}

let terminalTimer = null;

/** The `conclave` command in a terminal (src-tauri/src/terminal.rs): where it is, Remove and Reinstall. */
function renderTerminal(v) {
  setWords($('s-terminal-state'), v.words);
  setWords($('s-terminal-hint'), v.hint);
  $('s-terminal-hint').hidden = !v.hint;
  $('s-terminal-install').textContent = v.state === 'installed' ? 'Reinstall' : 'Install';
  $('s-terminal-install').hidden = !v.canInstall;
  $('s-terminal-remove').hidden = !v.canRemove;
  $('s-terminal-links').hidden = !v.canInstall && !v.canRemove;
  $('s-terminal-install').disabled = v.busy;
  $('s-terminal-remove').disabled = v.busy;
}

/** Followed every 800 ms while it downloads or sets up. */
async function refreshTerminal() {
  clearTimeout(terminalTimer);
  let v;
  try {
    v = await invoke('terminal_status');
  } catch (err) {
    setWords($('s-terminal-state'), String(err));
    return;
  }
  renderTerminal(v);
  if (v.busy && !$('settings').hidden) terminalTimer = setTimeout(refreshTerminal, 800);
}

$('s-terminal-install').addEventListener('click', async () => {
  showError('', 's-error');
  try {
    renderTerminal(await invoke('terminal_install'));
  } catch (err) {
    showError(String(err), 's-error');
  }
  refreshTerminal();
});

$('s-terminal-remove').addEventListener('click', async () => {
  showError('', 's-error');
  $('s-terminal-install').disabled = true;
  $('s-terminal-remove').disabled = true;
  setWords($('s-terminal-state'), 'Removing `conclave`.');
  try {
    renderTerminal(await invoke('terminal_remove'));
  } catch (err) {
    showError(String(err), 's-error');
    refreshTerminal();
  }
});

$('s-update-now').addEventListener('click', async () => {
  showError('', 's-error');
  $('s-update-links').hidden = true;
  $('s-update-state').textContent = 'Downloading and installing. Conclave restarts by itself.';
  try {
    await invoke('update_install');
  } catch (err) {
    showError(String(err), 's-error');
    refreshUpdate();
  }
});

async function showSettings() {
  showOnly('settings');
  refreshUpdate();
  refreshTerminal();
  $('s-autostart').checked = settings.autostart;
  $('s-allows').textContent = settings.allows;
  $('s-local-row').hidden = !settings.localAvailable && !settings.runHub;
  showConnection();
  refreshLocal();
  if (params.has('pair') && settings.hasToken) pairPhone();
  if (!settings.hasToken) {
    setState('Connect to a hub first.');
    return;
  }
  await refreshComputer();
}

$('s-local').addEventListener('change', async (event) => {
  const box = event.target;
  const on = box.checked;
  showError('', 's-error');
  box.disabled = true;
  $('s-local-state').textContent = on ? 'Starting…' : 'Stopping the hub…';
  $('s-local-state').hidden = false;
  try {
    // the first time, the hub may use this computer, as on the first-run page
    await invoke('local_hub_set', { on, computer: on ? settings.daemon && settings.computer !== false : null });
    settings = await invoke('get_settings');
    showConnection();
    if (!on) {
      $('pair').hidden = true;
      setState(settings.hasToken ? $('s-state').textContent : 'Connect to a hub first.');
    }
  } catch (err) {
    box.checked = !on;
    showError(String(err), 's-error');
  } finally {
    box.disabled = false;
    refreshLocal();
  }
});

$('s-lan').addEventListener('change', async (event) => {
  const box = event.target;
  const on = box.checked;
  showError('', 's-error');
  box.disabled = true;
  $('s-local-state').textContent = 'Starting the hub again…';
  $('s-local-state').hidden = false;
  try {
    await invoke('local_hub_lan', { on });
    settings = await invoke('get_settings');
  } catch (err) {
    box.checked = !on;
    showError(String(err), 's-error');
  } finally {
    box.disabled = false;
    refreshLocal();
  }
});

$('s-retry').addEventListener('click', async () => {
  await invoke('local_hub_retry').catch(() => {});
  refreshLocal();
});

$('s-logs').addEventListener('click', async () => {
  showError('', 's-error');
  try {
    await invoke('local_hub_logs');
  } catch (err) {
    showError(String(err), 's-error');
  }
});

$('s-computer').addEventListener('change', async (event) => {
  const box = event.target;
  const on = box.checked;
  showError('', 's-error');
  box.disabled = true;
  setState(on ? 'Turning on…' : 'Turning off…');
  try {
    if (on) setState((await invoke('computer_enable')).words);
    else setState(await invoke('computer_disable'));
    settings.computer = on;
  } catch (err) {
    box.checked = !on;
    showError(String(err), 's-error');
    await refreshComputer();
  } finally {
    box.disabled = false;
  }
});

const REACH = {
  anywhere: 'Phones can reach this hub from anywhere.',
  network: 'Phones on this network can scan it now. Away from home they need remote access.',
  here: 'Phones cannot reach this hub yet. Turn on remote access first.',
};

/** The code on screen. The hub's addresses can change while it shows (a tunnel came up or moved, remote access set). */
let shownPairing = null;
let pairTimer = 0;

function showPairing(p) {
  shownPairing = p;
  // the hub's own SVG, shown as a picture: nothing in it can run here
  $('pair-qr').src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.qrSvg)}`;
  $('pair-code').textContent = p.code;
  $('pair-reach').textContent =
    p.reach === 'here' && settings.runHub && !settings.hubLan
      ? 'Phones cannot reach this hub yet: turn on Remote access, or Let phones on this Wi-Fi connect above.'
      : REACH[p.reach] || '';
  $('pair').hidden = false;
}

/** Ask for the same code again now and then, so its QR carries the addresses the hub has now. */
function keepPairingFresh() {
  clearInterval(pairTimer);
  pairTimer = setInterval(async () => {
    if (!shownPairing || $('pair').hidden || Date.now() >= shownPairing.expiresAt) {
      clearInterval(pairTimer);
      return;
    }
    try {
      const p = await invoke('pair_phone', { code: shownPairing.code });
      if (p.qrSvg !== shownPairing.qrSvg) showPairing(p);
    } catch {
      // the code on screen still works on the addresses it has
    }
  }, 15_000);
}

async function pairPhone() {
  showError('', 's-error');
  $('s-pair').disabled = true;
  try {
    showPairing(await invoke('pair_phone'));
    keepPairingFresh();
    $('s-pair').textContent = 'New code';
  } catch (err) {
    showError(String(err), 's-error');
  } finally {
    $('s-pair').disabled = false;
  }
}

$('s-pair').addEventListener('click', pairPhone);

$('s-remote').addEventListener('click', async () => {
  showError('', 's-error');
  try {
    await invoke('open_remote_access');
  } catch (err) {
    showError(String(err), 's-error');
  }
});

$('s-change-hub').addEventListener('click', () => {
  location.href = 'index.html?setup=1';
});

$('s-back').addEventListener('click', async () => {
  showError('', 's-error');
  try {
    await invoke('open_hub');
  } catch (err) {
    showError(String(err), 's-error');
  }
});

// ---------------------------------------------------------------------------

/** On start with the hub here: wait for it, then open it. A failure shows Settings, with the reason. */
async function openLocal() {
  showOnly('starting');
  const v = await followHub((v) => {
    $('starting-state').textContent = v.words;
  });
  if (v.phase === 'running') {
    try {
      await invoke('open_hub');
      return;
    } catch (err) {
      showError(String(err), 's-error');
    }
  }
  settings = await invoke('get_settings');
  await showSettings();
}

async function start() {
  settings = await invoke('get_settings');
  const s = settings;
  const mac = /Mac/i.test(navigator.userAgent);
  $('shortcut').textContent = s.shortcut.replace('CommandOrControl', mac ? 'Cmd' : 'Ctrl');
  $('hub').value = params.get('hub') || (s.runHub ? '' : s.hubUrl) || s.defaultHub;
  $('credential').value = params.get('code') || '';
  // a pairing code first, as before; a member with only a name and password picks Password
  setWay('code');
  $('autostart').checked = s.autostart;
  // on until the owner says otherwise, so pairing and the daemon take one press
  $('computer-row').hidden = !s.daemon;
  $('computer').checked = s.computer !== false;
  $('computer-allows').textContent = s.allows;
  $('mode-local').hidden = !s.localAvailable;
  // a pairing link is for a hub elsewhere; otherwise the form shows what the app does now
  setMode(s.runHub && !params.has('code') ? 'local' : 'connect');

  if (params.has('settings')) return showSettings();

  // Opened from a conclave://pair link: connect straight away.
  if (params.get('auto') === '1' && $('credential').value) {
    showForm();
    return connect();
  }

  // The hub runs here: wait for it to be up, then open it.
  if (s.runHub && !params.has('setup')) return openLocal();

  // Normal start: go straight to the saved hub, fall back to the form if it is down.
  if (s.hubUrl && !params.has('setup')) {
    $('connecting-url').textContent = s.hubUrl;
    showOnly('connecting');
    try {
      await invoke('open_hub');
      return;
    } catch (err) {
      showError(`${err} Press Connect to retry.`);
    }
  }
  showForm();
}

for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener('change', () => setMode(input.value));
}

for (const input of document.querySelectorAll('input[name="way"]')) {
  input.addEventListener('change', () => setWay(input.value));
}

$('form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (mode === 'local') startLocal();
  else if (way === 'password') login();
  else connect();
});

$('open-anyway').addEventListener('click', async () => {
  try {
    await invoke('open_hub');
  } catch (err) {
    showError(String(err));
  }
});

for (const id of ['autostart', 's-autostart']) {
  $(id).addEventListener('change', async (event) => {
    const box = event.target;
    if (id === 'autostart') autostartTouched = true;
    // on the form in "run the hub here" mode, the box is applied when the hub starts
    if (id === 'autostart' && mode === 'local' && box.checked && !settings.autostart) return;
    try {
      await invoke('set_autostart', { enabled: box.checked });
      settings.autostart = box.checked;
    } catch (err) {
      box.checked = !box.checked;
      showError(String(err), id === 'autostart' ? 'error' : 's-error');
    }
  });
}

start().catch((err) => {
  showError(String(err));
  showForm();
});
