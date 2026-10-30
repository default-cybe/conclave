// Conclave desktop shell.
//
// The main window starts on a small bundled page (../src) that asks for the hub
// URL and a pairing code, a sign-in name and password, or a token, or runs the
// hub on this computer, then loads the hub's own web UI. The rest is native
// glue: tray menu, quick ask window, global shortcut, deep links, autostart,
// notifications, the daemon the app carries ("Let the hub use this
// computer", see computer.rs), the hub it can run ("Run the hub on this
// computer", see local.rs), its own updates (update.rs), the `conclave`
// command in a terminal (terminal.rs) and, as a Linux AppImage, its app menu
// entry (appimage.rs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod appimage;
mod computer;
mod hub;
mod local;
mod terminal;
mod update;
#[cfg(windows)]
mod winpath;

use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use hub::Settings;
use serde::Serialize;
use tauri::{
    ipc::CapabilityBuilder,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
const QUICK: &str = "quick";
const QUICK_SHORTCUT: &str = "CommandOrControl+Shift+Space";
/// The autostart entry passes this so login starts the app in the tray.
const HIDDEN_ARG: &str = "--hidden";
/// `conclave-desktop --quick` toggles quick ask in the running app. Bind it in
/// your compositor where global shortcuts are not available (Wayland).
const QUICK_ARG: &str = "--quick";

struct AppState {
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    /// Hub origins that already have their IPC capability.
    granted: Mutex<HashSet<String>>,
    autostart_item: Mutex<Option<CheckMenuItem<Wry>>>,
    /// One daemon change at a time (a double click, the start-up check).
    daemon_lock: Mutex<()>,
    /// "Run the hub on this computer" (local.rs).
    local_hub: local::Hub,
    /// The tray's hub status line.
    hub_line: Mutex<Option<MenuItem<Wry>>>,
    /// Quit was asked: the hub is stopping, then the app exits.
    quitting: AtomicBool,
    /// The app's own update (update.rs).
    updates: Arc<update::Updates>,
    /// The tray menu, and its "Update to X and restart" item while there is an update.
    menu: Mutex<Option<Menu<Wry>>>,
    update_item: Mutex<Option<MenuItem<Wry>>>,
    /// The `conclave` command in a terminal (terminal.rs).
    terminal: terminal::Terminal,
    /// A password login waiting for the person to check the hub's
    /// fingerprint. Its token stays here, never on the page or on disk, until Continue.
    pending_login: Mutex<Option<PendingLogin>>,
}

struct PendingLogin {
    base: Url,
    token: String,
    addresses: Vec<String>,
    client_id: Option<String>,
}

fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn hub_base(app: &AppHandle) -> Option<Url> {
    let st = state(app);
    let hub_url = st.settings.lock().unwrap().hub_url.clone();
    hub_url.and_then(|u| Url::parse(&u).ok())
}

// ---------------------------------------------------------------------------
// URLs and navigation
// ---------------------------------------------------------------------------

/// A URL on the bundled pages.
fn app_url(app: &AppHandle, path: &str) -> Url {
    let base = match app.config().build.dev_url.clone() {
        Some(dev) if tauri::is_dev() => dev,
        _ if cfg!(windows) => Url::parse("http://tauri.localhost/").unwrap(),
        _ => Url::parse("tauri://localhost/").unwrap(),
    };
    base.join(path).unwrap_or(base)
}

fn is_app_url(app: &AppHandle, url: &Url) -> bool {
    url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || url.origin() == app_url(app, "").origin()
}

/// Windows may show the bundled pages and the hub. Other links open in the browser.
fn allow_navigation(app: &AppHandle, url: &Url) -> bool {
    if is_app_url(app, url) || matches!(url.scheme(), "about" | "data" | "blob") {
        return true;
    }
    if hub_base(app).is_some_and(|base| base.origin() == url.origin()) {
        return true;
    }
    if follow_hub(app, url) {
        return true;
    }
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    false
}

/// The hub page moved itself to another address of the hub, with this app's
/// token in the fragment (a quick tunnel got a new address). Save the new
/// address and let the page go there.
fn follow_hub(app: &AppHandle, url: &Url) -> bool {
    let st = state(app);
    let next = {
        let s = st.settings.lock().unwrap();
        // the hub on this computer stays at its loopback address
        if s.run_hub {
            return false;
        }
        let Some(base) = s.hub_url.as_deref().and_then(|u| Url::parse(u).ok()) else {
            return false;
        };
        match hub::moved_to(&base, s.token.as_deref(), url) {
            Some(next) => next,
            None => return false,
        }
    };
    {
        let mut s = st.settings.lock().unwrap();
        s.hub_url = Some(next.to_string());
        if let Err(e) = s.save(&st.settings_path) {
            eprintln!("conclave: {e}");
        }
    }
    if let Err(e) = grant_hub_ipc(app, &next) {
        eprintln!("conclave: notifications at the new hub address: {e}");
    }
    update_tray_line(app);
    true
}

/// Keep the hub's address list, so a later start can fall back when the
/// saved address stops answering. Runs in the background; failures are quiet.
fn refresh_addresses(app: &AppHandle) {
    let (base, token) = {
        let st = state(app);
        let s = st.settings.lock().unwrap();
        (s.hub_url.clone(), s.token.clone())
    };
    let (Some(base), Some(token)) = (base.and_then(|u| Url::parse(&u).ok()), token) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(list) = hub::addresses(&base, &token) else {
            return;
        };
        if list.is_empty() {
            return;
        }
        let st = state(&app);
        let mut s = st.settings.lock().unwrap();
        // only for the hub the list came from
        if s.hub_url.as_deref() == Some(base.as_str()) && s.addresses != list {
            s.addresses = list;
            if let Err(e) = s.save(&st.settings_path) {
                eprintln!("conclave: {e}");
            }
        }
    });
}

/// Lets the hub page use native notifications (the notification plugin
/// replaces window.Notification). Nothing else is exposed to it.
fn grant_hub_ipc(app: &AppHandle, base: &Url) -> Result<(), String> {
    let origin = base.origin().ascii_serialization();
    let st = state(app);
    let mut granted = st.granted.lock().unwrap();
    if granted.contains(&origin) {
        return Ok(());
    }
    // The hub page may read the daemon's state and open the app's own settings,
    // where the switch is. It cannot turn the daemon on itself: that would give
    // a script on the hub page a shell on this computer. It may also read the
    // app's version and install the app's signed update (Settings > About).
    app.add_capability(
        CapabilityBuilder::new(format!("hub-{}", granted.len()))
            .remote(format!("{origin}/*"))
            .windows([MAIN, QUICK])
            .permission("notification:default")
            .permission("allow-computer-status")
            .permission("allow-open-settings")
            .permission("allow-update-status")
            .permission("allow-update-install"),
    )
    .map_err(|e| e.to_string())?;
    granted.insert(origin);
    Ok(())
}

/// The hub page for `query` ("" or e.g. "new=1"), with the token in the fragment.
fn hub_page(app: &AppHandle, query: &str) -> Result<Url, String> {
    let Settings { hub_url: base, token, .. } = state(app).settings.lock().unwrap().clone();
    let base = base.ok_or_else(|| "No hub is set up yet.".to_string())?;
    let base = Url::parse(&base).map_err(|e| e.to_string())?;
    grant_hub_ipc(app, &base)?;
    Ok(hub::page_url(&base, query, token.as_deref()))
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

fn main_window(app: &AppHandle, visible: bool) -> tauri::Result<WebviewWindow> {
    if let Some(win) = app.get_webview_window(MAIN) {
        return Ok(win);
    }
    let handle = app.clone();
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Conclave")
        .inner_size(1180.0, 800.0)
        .min_inner_size(400.0, 500.0)
        .visible(visible)
        .on_navigation(move |url| allow_navigation(&handle, url))
        // the hub page titles itself per page ("Inbox, Conclave"): the title bar, the Dock and the taskbar follow it
        .on_document_title_changed(|win, title| {
            if !title.is_empty() {
                let _ = win.set_title(&title);
            }
        })
        .build()
}

fn focus(win: &WebviewWindow) {
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
}

fn show_main(app: &AppHandle) {
    match main_window(app, true) {
        Ok(win) => focus(&win),
        Err(e) => eprintln!("conclave: cannot open the main window: {e}"),
    }
}

fn toggle_main(app: &AppHandle) {
    match app.get_webview_window(MAIN) {
        Some(win) if win.is_visible().unwrap_or(false) => {
            let _ = win.hide();
        }
        _ => show_main(app),
    }
}

/// Load `url` in the main window and bring it forward.
fn show_url(app: &AppHandle, url: Url) {
    match main_window(app, true) {
        Ok(win) => {
            let _ = win.navigate(url);
            focus(&win);
        }
        Err(e) => eprintln!("conclave: cannot open the main window: {e}"),
    }
}

/// The bundled connection page. `pairs` pre-fill the form (hub, code, auto).
fn show_setup(app: &AppHandle, pairs: &[(&str, &str)]) {
    let mut url = app_url(app, "index.html");
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("setup", "1");
        for (k, v) in pairs {
            query.append_pair(k, v);
        }
    }
    show_url(app, url);
}

/// The app's own settings: the hub, "Run the hub on this computer", "Let the
/// hub use this computer", start at login. `pair` opens the phone pairing QR.
fn show_settings(app: &AppHandle) {
    show_url(app, app_url(app, "index.html?settings=1"));
}

fn show_pairing(app: &AppHandle) {
    show_url(app, app_url(app, "index.html?settings=1&pair=1"));
}

fn load_hub(app: &AppHandle, query: &str) -> Result<(), String> {
    let url = hub_page(app, query)?;
    let win = main_window(app, true).map_err(|e| e.to_string())?;
    win.navigate(url).map_err(|e| e.to_string())
}

fn new_chat(app: &AppHandle) {
    match hub_page(app, "new=1") {
        Ok(url) => show_url(app, url),
        Err(_) => show_setup(app, &[]),
    }
}

/// Small always-on-top window with the hub in quick mode (?quick=1).
fn toggle_quick(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(QUICK) {
        if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
            let _ = win.hide();
        } else {
            focus(&win);
        }
        return;
    }
    let Ok(url) = hub_page(app, "quick=1") else {
        show_setup(app, &[]);
        return;
    };
    let handle = app.clone();
    let built = WebviewWindowBuilder::new(app, QUICK, WebviewUrl::External(url))
        .title("Conclave quick ask")
        .inner_size(640.0, 460.0)
        .min_inner_size(360.0, 240.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .focused(true)
        .on_navigation(move |url| allow_navigation(&handle, url))
        .build();
    if let Err(e) = built {
        eprintln!("conclave: cannot open quick ask: {e}");
    }
}

// ---------------------------------------------------------------------------
// Commands for the bundled page (see build.rs and capabilities/default.json)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    hub_url: Option<String>,
    has_token: bool,
    autostart: bool,
    default_hub: &'static str,
    shortcut: &'static str,
    /// "Let the hub use this computer": None until the owner chose.
    computer: Option<bool>,
    /// This build carries the daemon.
    daemon: bool,
    /// The one line that says what the switch allows.
    allows: &'static str,
    /// "Run the hub on this computer".
    run_hub: bool,
    /// There is a hub for this system to download (or CONCLAVE_HUB_BIN names one).
    local_available: bool,
    /// "Let phones on this Wi-Fi connect" for the hub on this computer.
    hub_lan: bool,
    /// The hub on this computer is a `conclave serve` the app found: its own settings decide.
    hub_adopted: bool,
    /// "Install updates automatically" (update.rs).
    auto_update: bool,
}

#[tauri::command]
fn get_settings(app: AppHandle) -> SettingsView {
    let s = state(&app).settings.lock().unwrap().clone();
    SettingsView {
        hub_url: s.hub_url.as_deref().map(hub::display),
        has_token: s.token.is_some(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        default_hub: hub::DEFAULT_HUB,
        shortcut: QUICK_SHORTCUT,
        computer: s.computer,
        daemon: computer::bundled().is_ok(),
        allows: computer::ALLOWS,
        run_hub: s.run_hub,
        local_available: std::env::var_os(local::BIN_ENV).is_some() || local::this_asset().is_ok(),
        hub_lan: s.hub_lan,
        hub_adopted: s.hub_adopted,
        auto_update: s.auto_update != Some(false),
    }
}

/// Check the hub, trade a pairing code for a token if one was given, save, load the hub.
/// `alts` are the other addresses from a pairing link, tried in order when the first does not answer.
/// `open: false` saves without loading the hub, so the page can turn the daemon on first.
#[tauri::command]
async fn connect(app: AppHandle, hub_url: String, credential: String, alts: Option<Vec<String>>, open: Option<bool>) -> Result<(), String> {
    let first = hub::normalize(&hub_url)?;
    let credential = credential.trim().to_string();
    // a password login still waiting on its fingerprint is not kept
    drop_pending_login(&app);
    let previous = state(&app).settings.lock().unwrap().clone();
    leave_local_hub(&app).await?;
    let alts: Vec<Url> = alts.unwrap_or_default().iter().filter_map(|u| hub::normalize(u).ok()).collect();
    let (base, token, addresses) = tauri::async_runtime::spawn_blocking(move || -> Result<(Url, Option<String>, Vec<String>), String> {
        // the first address that answers; the error names the first one
        let base = match hub::health(&first) {
            Ok(()) => first,
            Err(e) => alts.into_iter().find(|u| hub::health(u).is_ok()).ok_or(e)?,
        };
        if credential.is_empty() {
            // Reconnecting to the same hub keeps the saved token and addresses.
            let same_hub = previous.hub_url.as_deref() == Some(base.as_str());
            let addresses = if same_hub { previous.addresses } else { Vec::new() };
            return Ok((base, previous.token.filter(|_| same_hub), addresses));
        }
        if hub::looks_like_code(&credential) {
            let (token, addresses) = hub::pair(&base, &credential)?;
            return Ok((base, Some(token), addresses));
        }
        hub::check_token(&base, &credential)?;
        Ok((base, Some(credential), Vec::new()))
    })
    .await
    .map_err(|e| e.to_string())??;
    use_hub(&app, base, token, addresses, open.unwrap_or(true))
}

/// Connecting to a hub elsewhere: this computer stops running one.
async fn leave_local_hub(app: &AppHandle) -> Result<(), String> {
    if !state(app).settings.lock().unwrap().run_hub {
        return Ok(());
    }
    set_run_hub(app, false)?;
    let local_hub = state(app).local_hub.clone();
    tauri::async_runtime::spawn_blocking(move || local_hub.stop(Duration::from_secs(20))).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Save the hub, its token and its addresses, then what every new connection
/// does: the quick window and the tray follow, the terminal command signs in
/// to it, and the hub loads unless `open` is false.
fn use_hub(app: &AppHandle, base: Url, token: Option<String>, addresses: Vec<String>, open: bool) -> Result<(), String> {
    {
        let st = state(app);
        let mut current = st.settings.lock().unwrap();
        // the terminal command's state as it is now (its sync may have saved since)
        let settings = Settings { hub_url: Some(base.to_string()), token, addresses, computer: current.computer, hub_port: current.hub_port, terminal: current.terminal.clone(), auto_update: current.auto_update, ..Default::default() };
        settings.save(&st.settings_path)?;
        *current = settings;
    }
    // The quick window may still show the old hub.
    if let Some(quick) = app.get_webview_window(QUICK) {
        let _ = quick.destroy();
    }
    update_tray_line(app);
    // `conclave` in a terminal follows the app to this hub (a login the app wrote, never yours)
    start_terminal(app, false);
    if open {
        load_hub(app, "")?;
    }
    refresh_addresses(app);
    Ok(())
}

/// Whether the hub at `hub_url` has more than one person, so the password
/// login asks for a name (GET /api/health).
#[tauri::command]
async fn hub_people(hub_url: String) -> Result<bool, String> {
    let base = hub::normalize(&hub_url)?;
    tauri::async_runtime::spawn_blocking(move || hub::people(&base)).await.map_err(|e| e.to_string())?
}

/// What the page shows before Continue: the hub's fingerprint to compare.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginView {
    hub_name: Option<String>,
    /// In groups of four. None from a hub before hub identity: nothing to show.
    fingerprint: Option<String>,
    /// Who it signed in as, as the apps show the name.
    account: Option<String>,
}

/// Log in with a sign-in name or email and password (POST /api/login), the
/// way the web app's Password does. A password login has no code to check
/// the hub against, so nothing is saved yet: the page shows the hub's
/// fingerprint, and login_confirm keeps the token, login_cancel signs it out
/// again. The password is used for this one request only.
#[tauri::command]
async fn login(app: AppHandle, hub_url: String, account: Option<String>, password: String) -> Result<LoginView, String> {
    let base = hub::normalize(&hub_url)?;
    if password.is_empty() {
        return Err("Enter the password.".into());
    }
    drop_pending_login(&app);
    let (base, reply) = tauri::async_runtime::spawn_blocking(move || hub::login(&base, account.as_deref(), &password).map(|reply| (base, reply)))
        .await
        .map_err(|e| e.to_string())??;
    let view = LoginView { hub_name: reply.hub.as_ref().and_then(|h| h.name.clone()), fingerprint: reply.fingerprint(), account: reply.shown_name() };
    *state(&app).pending_login.lock().unwrap() = Some(PendingLogin { base, token: reply.token, addresses: reply.addresses, client_id: reply.client_id });
    Ok(view)
}

/// The person checked the fingerprint: keep the login's token and go on as
/// after pairing. `open: false` saves without loading the hub, as for connect.
#[tauri::command]
async fn login_confirm(app: AppHandle, open: Option<bool>) -> Result<(), String> {
    let pending = state(&app).pending_login.lock().unwrap().take().ok_or_else(|| "Log in again.".to_string())?;
    leave_local_hub(&app).await?;
    use_hub(&app, pending.base, Some(pending.token), pending.addresses, open.unwrap_or(true))
}

/// Not the hub, or the person went back: the login's token is signed out on the hub and forgotten.
#[tauri::command]
fn login_cancel(app: AppHandle) {
    drop_pending_login(&app);
}

/// Forget a waiting login, and sign its token out on the hub in the background.
fn drop_pending_login(app: &AppHandle) {
    let Some(p) = state(app).pending_login.lock().unwrap().take() else { return };
    let Some(id) = p.client_id else { return };
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = hub::revoke_client(&p.base, &p.token, &id) {
            eprintln!("conclave: signing out a login that was not kept: {e}");
        }
    });
}

/// Open the saved hub if it answers, else the first of its other addresses
/// that does (the same network, a stable name). The bundled page calls this on start.
/// A saved token the hub turns away fails with hub::REJECTED, so the page asks
/// to sign in again; any other failure, it tries again (src/start.js).
#[tauri::command]
async fn open_hub(app: AppHandle) -> Result<(), String> {
    let base = hub_base(&app).ok_or_else(|| "No hub is set up yet.".to_string())?;
    let (saved, token) = {
        let st = state(&app);
        let s = st.settings.lock().unwrap();
        (s.addresses.clone(), s.token.clone())
    };
    let moved = tauri::async_runtime::spawn_blocking(move || -> Result<Option<Url>, String> {
        let moved = match hub::health(&base) {
            Ok(()) => None,
            Err(err) => Some(
                hub::fallbacks(base.as_str(), &saved)
                    .into_iter()
                    .find(|u| hub::health(u).is_ok())
                    .ok_or_else(|| format!("{err} If the hub has a new address, scan a new pairing code or enter the address here."))?,
            ),
        };
        // only a clear 401/403 counts: any other answer opens the hub as before
        if let Some(token) = &token {
            if let Ok(false) = hub::token_works(moved.as_ref().unwrap_or(&base), token) {
                return Err(format!("{} Sign in again.", hub::REJECTED));
            }
        }
        Ok(moved)
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(next) = moved {
        let st = state(&app);
        let mut s = st.settings.lock().unwrap();
        s.hub_url = Some(next.to_string());
        s.save(&st.settings_path)?;
    }
    load_hub(&app, "")?;
    refresh_addresses(&app);
    Ok(())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_autostart(&app, enabled)
}

fn apply_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    if launcher.is_enabled().unwrap_or(false) != enabled {
        let result = if enabled { launcher.enable() } else { launcher.disable() };
        result.map_err(|e| format!("Cannot change start at login: {e}"))?;
    }
    if let Some(item) = state(app).autostart_item.lock().unwrap().as_ref() {
        let _ = item.set_checked(enabled);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// "Let the hub use this computer" (computer.rs)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComputerView {
    /// The switch.
    enabled: bool,
    /// This build carries the daemon.
    available: bool,
    /// The hub lists this computer as online.
    online: bool,
    /// The name this computer paired with.
    name: Option<String>,
    /// The daemon's version, while it is on.
    version: Option<String>,
    /// The state in one line.
    words: String,
    allows: &'static str,
}

/// Where the service's own copy of the daemon lives (it survives app updates).
fn stable_copy(app: &AppHandle) -> Result<computer::Stable, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(computer::Stable::new(dir.join("daemon")))
}

fn hub_creds(app: &AppHandle) -> Result<(Url, String), String> {
    let s = state(app).settings.lock().unwrap().clone();
    let base = s.hub_url.and_then(|u| Url::parse(&u).ok());
    match (base, s.token) {
        (Some(base), Some(token)) => Ok((base, token)),
        _ => Err("Connect to a hub first.".into()),
    }
}

fn set_computer(app: &AppHandle, on: bool) -> Result<(), String> {
    let st = state(app);
    let mut s = st.settings.lock().unwrap();
    s.computer = Some(on);
    s.save(&st.settings_path)
}

fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// How the hub sees the device with this id, or None when it does not answer.
fn seen_on_hub(app: &AppHandle, device_id: Option<&str>) -> Option<computer::Seen> {
    let (base, token) = hub_creds(app).ok()?;
    let list = hub::devices(&base, &token).ok()?;
    Some(match device_id.and_then(|id| list.iter().find(|d| d.id == id)) {
        Some(d) if d.online => computer::Seen::Online,
        Some(_) => computer::Seen::Offline,
        None => computer::Seen::Missing,
    })
}

fn computer_view(app: &AppHandle) -> ComputerView {
    let enabled = state(app).settings.lock().unwrap().computer == Some(true);
    let available = computer::bundled().is_ok();
    let local = if enabled {
        stable_copy(app).ok().filter(|s| s.exists()).and_then(|s| computer::status(&s.bin).ok())
    } else {
        None
    };
    let seen = local.as_ref().and_then(|l| seen_on_hub(app, l.device_id.as_deref()));
    let words = if available || enabled {
        computer::words(enabled, local.as_ref(), seen)
    } else {
        "This build of the app has no daemon. The release download has it.".into()
    };
    ComputerView {
        enabled,
        available,
        online: enabled && seen == Some(computer::Seen::Online),
        version: local.as_ref().map(|l| l.version.clone()).filter(|v| !v.is_empty()),
        name: local.and_then(|l| l.name),
        words,
        allows: computer::ALLOWS,
    }
}

/// Pair the daemon with the app's own hub and token (no second code), install
/// the user service that runs the stable copy, start it, wait a moment for it
/// to come online. The steps are the daemon's own subcommands (computer.rs).
fn enable_blocking(app: &AppHandle) -> Result<ComputerView, String> {
    let (base, token) = hub_creds(app)?;
    let bundled = computer::bundled()?;
    let stable = stable_copy(app)?;
    computer::sync(&stable, &bundled, &app_version(app))?;
    let was_paired = computer::status(&stable.bin)?.paired;
    computer::pair(&stable.bin, &hub::display(base.as_str()), &token)?;
    if let Err(e) = computer::install(&stable.bin) {
        if !was_paired {
            // leave nothing half done: no stray device on the hub
            let _ = computer::uninstall(&stable.bin);
        }
        return Err(e);
    }
    set_computer(app, true)?;
    let id = computer::status(&stable.bin).ok().and_then(|l| l.device_id);
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && seen_on_hub(app, id.as_deref()) != Some(computer::Seen::Online) {
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(computer_view(app))
}

/// Stop and remove the service, unpair the device, and say what happened.
fn disable_blocking(app: &AppHandle) -> Result<String, String> {
    let was_on = state(app).settings.lock().unwrap().computer == Some(true);
    let stable = stable_copy(app)?;
    if !was_on && !stable.exists() {
        // nothing of ours runs here (a daemon from the install script is left alone)
        set_computer(app, false)?;
        return Ok(computer::words(false, None, None));
    }
    let bin = if stable.exists() { stable.bin.clone() } else { computer::bundled()? };
    let done = computer::uninstall(&bin)?;
    set_computer(app, false)?;
    if bin == stable.bin {
        let _ = std::fs::remove_dir_all(&stable.dir);
    }
    Ok(computer::off_words(&done))
}

/// After an app update the bundled daemon is new: replace the stable copy and
/// restart the service, so it does not keep running the old version.
fn refresh_daemon(app: &AppHandle) {
    if state(app).settings.lock().unwrap().computer != Some(true) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let st = state(&app);
        let _guard = st.daemon_lock.lock().unwrap();
        let (Ok(bundled), Ok(stable)) = (computer::bundled(), stable_copy(&app)) else {
            return;
        };
        match computer::sync(&stable, &bundled, &app_version(&app)) {
            // install restarts the service, so it runs the new copy
            Ok(true) => {
                if let Err(e) = computer::install(&stable.bin) {
                    eprintln!("conclave: after the update: {e}");
                }
            }
            Ok(false) => {}
            Err(e) => eprintln!("conclave: {e}"),
        }
    });
}

#[tauri::command]
async fn computer_status(app: AppHandle) -> Result<ComputerView, String> {
    tauri::async_runtime::spawn_blocking(move || computer_view(&app)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn computer_enable(app: AppHandle) -> Result<ComputerView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = state(&app);
        let _guard = st.daemon_lock.lock().unwrap();
        enable_blocking(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn computer_disable(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = state(&app);
        let _guard = st.daemon_lock.lock().unwrap();
        disable_blocking(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The hub page's way to the switch: it opens the app's own settings page.
#[tauri::command]
fn open_settings(app: AppHandle) {
    show_settings(&app);
}

// ---------------------------------------------------------------------------
// "Run the hub on this computer" (local.rs)
// ---------------------------------------------------------------------------

/// The manager's view of the app: saved port, connecting, the tray line.
struct LocalHost(AppHandle);

impl local::Host for LocalHost {
    fn saved(&self) -> (Option<u16>, bool) {
        let st = state(&self.0);
        let s = st.settings.lock().unwrap();
        (s.hub_port, s.hub_adopted)
    }

    fn remember(&self, port: u16, adopted: bool) {
        let st = state(&self.0);
        let mut s = st.settings.lock().unwrap();
        if s.hub_port != Some(port) || s.hub_adopted != adopted {
            s.hub_port = Some(port);
            s.hub_adopted = adopted;
            if let Err(e) = s.save(&st.settings_path) {
                eprintln!("conclave: {e}");
            }
        }
    }

    fn connected(&self, hub: &local::Hub, base: &Url, token: &str) -> Result<(), String> {
        local_connected(&self.0, hub, base, token)
    }

    fn changed(&self, _status: &local::Status) {
        update_tray_line(&self.0);
    }

    fn lan(&self) -> bool {
        state(&self.0).settings.lock().unwrap().hub_lan
    }
}

/// The hub on this computer proved its key and `token` is its owner token
/// (read from its home, this user only): the app uses it, with no code. Then
/// this computer's daemon pairs with it the same way, with the app's token.
fn local_connected(app: &AppHandle, hub: &local::Hub, base: &Url, token: &str) -> Result<(), String> {
    hub::check_token(base, token)?;
    let st = state(app);
    let (changed, computer) = {
        let mut s = st.settings.lock().unwrap();
        if !s.run_hub {
            return Err("It was turned off.".into());
        }
        let changed = s.hub_url.as_deref() != Some(base.as_str()) || s.token.as_deref() != Some(token);
        if changed {
            s.hub_url = Some(base.to_string());
            s.token = Some(token.to_string());
            s.addresses = Vec::new();
            s.save(&st.settings_path)?;
        }
        (changed, s.computer)
    };
    grant_hub_ipc(app, base)?;
    // The hub just became ready: it started, started again after a stop, or is another one. A window
    // that showed it loads it again: its old address, or what it showed while the hub was away (an
    // error page, the "not built" page of a hub that had no web files).
    if let Some(quick) = app.get_webview_window(QUICK) {
        if changed {
            let _ = quick.destroy();
        } else if let Ok(url) = hub_page(app, "quick=1") {
            let _ = quick.navigate(url);
        }
    }
    if let Some(win) = app.get_webview_window(MAIN) {
        if win.url().is_ok_and(|u| !is_app_url(app, &u)) {
            let _ = load_hub(app, "");
        }
    }
    refresh_addresses(app);
    // `conclave` in a terminal signs in to this hub too (it could not while the hub was starting)
    start_terminal(app, false);
    hub.set_computer_error(None);
    if computer == Some(true) && computer::bundled().is_ok() {
        let _guard = st.daemon_lock.lock().unwrap();
        if !daemon_on(app, base) {
            if let Err(e) = enable_blocking(app) {
                hub.set_computer_error(Some(e));
            }
        }
    }
    Ok(())
}

/// The daemon's service runs paired with the hub at `base` already.
fn daemon_on(app: &AppHandle, base: &Url) -> bool {
    let Ok(stable) = stable_copy(app) else { return false };
    stable.exists()
        && computer::status(&stable.bin).is_ok_and(|l| l.paired && l.installed && l.running != Some(false) && l.hub.as_deref().and_then(|h| hub::normalize(h).ok()).as_ref() == Some(base))
}

fn local_setup(app: &AppHandle) -> Result<local::Setup, String> {
    let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let home_dir = app.path().home_dir().ok();
    let env_path = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    Ok(local::Setup {
        layout: local::Layout { data },
        version: app_version(app),
        releases: std::env::var(local::RELEASES_ENV).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| local::RELEASES.into()),
        bin: env_path(local::BIN_ENV),
        // the CLI's own hub of this user: a `conclave serve` running from there may be used instead
        user_home: env_path("CONCLAVE_HOME").or_else(|| home_dir.as_ref().map(|h| h.join(".conclave"))),
        home_dir,
    })
}

fn start_local_hub(app: &AppHandle) -> Result<(), String> {
    let setup = local_setup(app)?;
    state(app).local_hub.start(setup, Arc::new(LocalHost(app.clone())));
    Ok(())
}

/// The switch. Off also forgets the hub address when it is the one on this
/// computer, so the app shows its setup page instead of a hub that is gone.
fn set_run_hub(app: &AppHandle, on: bool) -> Result<(), String> {
    let st = state(app);
    let mut s = st.settings.lock().unwrap();
    s.run_hub = on;
    if !on {
        let local = s.hub_port.map(|p| local::local_base(p).to_string());
        if s.hub_url.is_some() && s.hub_url == local {
            s.hub_url = None;
            s.token = None;
            s.addresses.clear();
        }
        s.hub_adopted = false;
    }
    s.save(&st.settings_path)
}

/// The tray's first line: the hub this app uses, and how the one on this computer is doing.
fn update_tray_line(app: &AppHandle) {
    let st = state(app);
    let (run_hub, remote) = {
        let s = st.settings.lock().unwrap();
        let remote = s.hub_url.as_deref().and_then(|u| Url::parse(u).ok()).and_then(|u| {
            let host = u.host_str()?.to_string();
            Some(match u.port() {
                Some(p) => format!("{host}:{p}"),
                None => host,
            })
        });
        (s.run_hub, remote)
    };
    let text = local::tray_line(run_hub, &st.local_hub.status(), remote.as_deref());
    let item = st.hub_line.lock().unwrap().clone();
    if let Some(item) = item {
        let _ = item.set_text(text);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalHubView {
    /// The switch.
    on: bool,
    #[serde(flatten)]
    status: local::Status,
    /// The state in a sentence or two.
    words: String,
}

fn local_view(app: &AppHandle) -> LocalHubView {
    let st = state(app);
    let on = st.settings.lock().unwrap().run_hub;
    let status = st.local_hub.status();
    let words = local::words(&status);
    LocalHubView { on, status, words }
}

#[tauri::command]
fn local_hub_status(app: AppHandle) -> LocalHubView {
    local_view(&app)
}

/// Turn the hub on this computer on or off. On returns at once; the page
/// follows local_hub_status. `computer`: the "Let the hub use this computer"
/// box of the same form (off was already applied with computer_disable).
#[tauri::command]
async fn local_hub_set(app: AppHandle, on: bool, computer: Option<bool>) -> Result<LocalHubView, String> {
    if on {
        if computer == Some(true) {
            let st = state(&app);
            let mut s = st.settings.lock().unwrap();
            s.computer = Some(true);
            s.save(&st.settings_path)?;
        }
        set_run_hub(&app, true)?;
        start_local_hub(&app)?;
    } else {
        set_run_hub(&app, false)?;
        let local_hub = state(&app).local_hub.clone();
        tauri::async_runtime::spawn_blocking(move || local_hub.stop(Duration::from_secs(20))).await.map_err(|e| e.to_string())?;
        if let Some(quick) = app.get_webview_window(QUICK) {
            let _ = quick.destroy();
        }
    }
    update_tray_line(&app);
    Ok(local_view(&app))
}

/// "Let phones on this Wi-Fi connect". The app's own hub starts again to listen
/// on every address, or on 127.0.0.1 only; a hub the app found running keeps its own.
#[tauri::command]
async fn local_hub_lan(app: AppHandle, on: bool) -> Result<LocalHubView, String> {
    let restart = {
        let st = state(&app);
        let mut s = st.settings.lock().unwrap();
        if s.hub_lan == on {
            false
        } else {
            s.hub_lan = on;
            s.save(&st.settings_path)?;
            s.run_hub && !s.hub_adopted
        }
    };
    if restart {
        let local_hub = state(&app).local_hub.clone();
        tauri::async_runtime::spawn_blocking(move || local_hub.stop(Duration::from_secs(20))).await.map_err(|e| e.to_string())?;
        if state(&app).settings.lock().unwrap().run_hub {
            start_local_hub(&app)?;
        }
    }
    update_tray_line(&app);
    Ok(local_view(&app))
}

/// Try again now, after a failure or during a wait.
#[tauri::command]
fn local_hub_retry(app: AppHandle) {
    state(&app).local_hub.retry();
}

/// Open the hub's log folder: hub.log (its output) and hub-<day>.jsonl (its own log files).
#[tauri::command]
fn local_hub_logs(app: AppHandle) -> Result<(), String> {
    let setup = local_setup(&app)?;
    let adopted = state(&app).settings.lock().unwrap().hub_adopted;
    let home = if adopted { setup.user_home.unwrap_or_else(|| setup.layout.home()) } else { setup.layout.home() };
    let dir = home.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot make {}: {e}", dir.display()))?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| format!("Cannot open {}: {e}", dir.display()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairView {
    code: String,
    qr_svg: String,
    expires_at: u64,
    /// Where phones can reach the hub from.
    reach: hub::Reach,
}

/// A pairing code and QR for a phone, from the hub this app uses. With
/// `code`, the one on screen again with the hub's addresses now.
#[tauri::command]
async fn pair_phone(app: AppHandle, code: Option<String>) -> Result<PairView, String> {
    let (base, token) = hub_creds(&app)?;
    let p = tauri::async_runtime::spawn_blocking(move || hub::create_pairing(&base, &token, code.as_deref())).await.map_err(|e| e.to_string())??;
    Ok(PairView { reach: hub::reach(&p.addresses), code: p.code, qr_svg: p.qr_svg, expires_at: p.expires_at })
}

/// The hub's Settings > Remote access, in the main window.
#[tauri::command]
fn open_remote_access(app: AppHandle) -> Result<(), String> {
    let (base, token) = hub_creds(&app)?;
    grant_hub_ipc(&app, &base)?;
    show_url(&app, hub::page_at(&base, "settings/remote", Some(&token)));
    Ok(())
}

// ---------------------------------------------------------------------------
// `conclave` in a terminal (terminal.rs)
// ---------------------------------------------------------------------------

/// The terminal command's view of the app: its saved state, the hub, the CLI binary.
struct TerminalHost(AppHandle);

impl terminal::Host for TerminalHost {
    fn saved(&self) -> terminal::Saved {
        state(&self.0).settings.lock().unwrap().terminal.clone()
    }

    fn save(&self, saved: terminal::Saved) {
        let st = state(&self.0);
        let mut s = st.settings.lock().unwrap();
        if s.terminal != saved {
            s.terminal = saved;
            if let Err(e) = s.save(&st.settings_path) {
                eprintln!("conclave: {e}");
            }
        }
    }

    fn version(&self) -> String {
        app_version(&self.0)
    }

    fn hub(&self) -> Option<(Url, String)> {
        hub_creds(&self.0).ok()
    }

    fn binary(&self, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<(PathBuf, Option<String>), String> {
        let setup = local_setup(&self.0)?;
        if let Some(bin) = setup.bin {
            return if bin.is_file() { Ok((bin, None)) } else { Err(format!("{} names {}, which is not a file.", local::BIN_ENV, bin.display())) };
        }
        let asset = local::this_asset()?;
        let mut step = |s: local::Step| {
            if let local::Step::Download { done, total } = s {
                progress(done, total);
            }
        };
        let app = self.0.clone();
        let keep_going = move || !state(&app).quitting.load(Ordering::SeqCst);
        match local::ensure(&setup.layout, &setup.releases, &setup.version, &asset, &mut step, &keep_going) {
            Ok(exe) => Ok((exe, Some(setup.version))),
            // the version that is here keeps working until this one can be downloaded
            Err(e) => setup.layout.newest_installed(&asset).map(|(v, exe)| (exe, Some(v))).ok_or(e),
        }
    }

    fn prune(&self, keep: &str) {
        let st = state(&self.0);
        // the hub on this computer prunes the versions itself, after it runs the new one
        if st.settings.lock().unwrap().run_hub || st.local_hub.active() {
            return;
        }
        if let Ok(setup) = local_setup(&self.0) {
            setup.layout.prune(keep);
        }
    }

    fn terminal_path(&self) -> Option<String> {
        if cfg!(windows) {
            return None;
        }
        // macOS terminals open login shells; on Linux an interactive shell starts from the session's PATH
        let macos = cfg!(target_os = "macos");
        let env = (!macos).then(|| local::child_env(std::env::vars(), std::env::var("APPDIR").ok().as_deref()));
        local::shell_path(&local::user_shell(), macos, env)
    }

    fn mint(&self, base: &Url, token: &str) -> Result<serde_json::Value, String> {
        hub::pair_terminal(base, token, &terminal::client_name(), terminal::cli_platform())
    }

    fn token_works(&self, base: &Url, token: &str) -> Result<bool, String> {
        hub::token_works(base, token)
    }

    fn revoke(&self, base: &Url, token: &str, client: &str) {
        if let Err(e) = hub::revoke_client(base, token, client) {
            eprintln!("conclave: signing the terminal out of the hub: {e}");
        }
    }
}

fn terminal_setup(app: &AppHandle) -> Result<terminal::Setup, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let env_path = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    Ok(terminal::Setup {
        paths: terminal::Paths::new(home, data, env_path("LOCALAPPDATA"), env_path("CONCLAVE_HOME")),
        shell: terminal::shell_kind(&local::user_shell()),
        macos: cfg!(target_os = "macos"),
        zdotdir: env_path("ZDOTDIR"),
        config_home: env_path("XDG_CONFIG_HOME"),
    })
}

/// Set the command up in the background (terminal.rs `sync`). `forced`: Reinstall.
fn start_terminal(app: &AppHandle, forced: bool) {
    let app = app.clone();
    std::thread::spawn(move || match terminal_setup(&app) {
        Ok(setup) => state(&app).terminal.clone().sync(&TerminalHost(app.clone()), &setup, forced),
        Err(e) => eprintln!("conclave: the terminal command: {e}"),
    });
}

#[tauri::command]
fn terminal_status(app: AppHandle) -> Result<terminal::View, String> {
    let setup = terminal_setup(&app)?;
    Ok(state(&app).terminal.view(&setup.paths))
}

/// Install or Reinstall: returns at once, busy; the page follows terminal_status.
#[tauri::command]
fn terminal_install(app: AppHandle) -> Result<terminal::View, String> {
    let setup = terminal_setup(&app)?;
    let t = state(&app).terminal.clone();
    t.queued();
    start_terminal(&app, true);
    Ok(t.view(&setup.paths))
}

#[tauri::command]
async fn terminal_remove(app: AppHandle) -> Result<terminal::View, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let setup = terminal_setup(&app)?;
        let t = state(&app).terminal.clone();
        t.remove(&TerminalHost(app.clone()), &setup)?;
        Ok(t.view(&setup.paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// The app's own updates (update.rs)
// ---------------------------------------------------------------------------

/// The tray follows the update: "Update to X and restart" while there is one.
struct UpdateHost(AppHandle);

impl update::Host for UpdateHost {
    fn changed(&self, view: &update::View) {
        let app = &self.0;
        let st = state(app);
        let mut item = st.update_item.lock().unwrap();
        match (update::words(view), item.as_ref()) {
            (Some(text), Some(existing)) => {
                let _ = existing.set_text(text);
            }
            (Some(text), None) => {
                let Some(menu) = st.menu.lock().unwrap().clone() else { return };
                // under the hub line and its separator
                if let Ok(new) = MenuItem::with_id(app, "update", text, true, None::<&str>) {
                    if menu.insert(&new, 2).is_ok() {
                        *item = Some(new);
                    }
                }
            }
            (None, Some(existing)) => {
                if let Some(menu) = st.menu.lock().unwrap().clone() {
                    let _ = menu.remove(existing);
                }
                *item = None;
            }
            (None, None) => {}
        }
    }

    fn auto(&self) -> bool {
        state(&self.0).settings.lock().unwrap().auto_update != Some(false)
    }

    /// Idle: the owner is not in a window of the app, and the hub on this
    /// computer, when the app runs one, has no session running or waiting for
    /// an approval. A hub elsewhere is not stopped by an update.
    fn idle(&self) -> bool {
        let app = &self.0;
        let in_use = |label: &str| app.get_webview_window(label).is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
        if in_use(MAIN) || in_use(QUICK) {
            return false;
        }
        let st = state(app);
        if !st.local_hub.active() {
            return true;
        }
        match st.local_hub.status().phase {
            local::Phase::Running => {}
            // starting or stopping: look again at the next check
            local::Phase::Getting | local::Phase::Unpacking | local::Phase::Starting | local::Phase::Connecting | local::Phase::Stopping => return false,
            // not serving: nothing runs on it
            local::Phase::Off | local::Phase::Waiting | local::Phase::Retrying | local::Phase::Failed => return true,
        }
        let Ok((base, token)) = hub_creds(app) else { return false };
        let busy = |status: &str| hub::has_session(&base, &token, status).unwrap_or(true);
        !busy("running") && !busy("waiting_approval")
    }

    fn install(&self) -> Result<(), String> {
        let app = self.0.clone();
        let updates = state(&app).updates.clone();
        let local_hub = state(&app).local_hub.clone();
        let before = move || {
            if local_hub.active() {
                local_hub.stop(Duration::from_secs(15));
            }
        };
        tauri::async_runtime::block_on(update::install(&app, &updates, before))
    }

    fn notify(&self, version: &str) {
        use tauri_plugin_notification::NotificationExt;
        let shown = self.0.notification().builder().title("Conclave").body(format!("Conclave {version} is ready. Click to update.")).show();
        if let Err(e) = shown {
            eprintln!("conclave: update notification: {e}");
        }
    }
}

/// Download, check and install the update, then start the new version. The hub on this computer stops first.
fn install_update(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let updates = state(&app).updates.clone();
        let local_hub = state(&app).local_hub.clone();
        let before = move || {
            if local_hub.active() {
                local_hub.stop(Duration::from_secs(15));
            }
        };
        if let Err(e) = update::install(&app, &updates, before).await {
            eprintln!("conclave: {e}");
        }
    });
}

#[tauri::command]
fn update_status(app: AppHandle) -> update::View {
    state(&app).updates.view()
}

#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), String> {
    let updates = state(&app).updates.clone();
    let local_hub = state(&app).local_hub.clone();
    let before = move || {
        if local_hub.active() {
            local_hub.stop(Duration::from_secs(15));
        }
    };
    update::install(&app, &updates, before).await
}

/// "Install updates automatically" on the settings page.
#[tauri::command]
fn update_auto(app: AppHandle, on: bool) -> Result<(), String> {
    let st = state(&app);
    let mut s = st.settings.lock().unwrap();
    s.auto_update = Some(on);
    s.save(&st.settings_path)
}

/// Quit: the hub on this computer stops cleanly first (closing its stdin), then the app exits.
fn quit(app: &AppHandle) {
    let st = state(app);
    if st.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let local_hub = st.local_hub.clone();
    if !local_hub.active() {
        app.exit(0);
        return;
    }
    update_tray_line(app);
    let app = app.clone();
    std::thread::spawn(move || {
        local_hub.stop(Duration::from_secs(15));
        app.exit(0);
    });
}

// ---------------------------------------------------------------------------
// Deep links, tray, startup
// ---------------------------------------------------------------------------

/// conclave://pair?url=<hub>&code=<code>&alt=<other address> (the hub's pairing QR), conclave://new, conclave://open.
fn handle_deep_link(app: &AppHandle, url: &Url) {
    let action = url.host_str().unwrap_or_else(|| url.path().trim_matches('/'));
    match action {
        "pair" => {
            let get = |key: &str| url.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
            let hub = get("url").unwrap_or_default();
            let code = get("code").unwrap_or_default();
            // the hub's other addresses, tried in order when the first does not answer
            let alts: Vec<String> = url.query_pairs().filter(|(k, _)| k == "alt").map(|(_, v)| v.into_owned()).collect();
            let mut pairs = vec![("hub", hub.as_str()), ("code", code.as_str()), ("auto", "1")];
            pairs.extend(alts.iter().map(|a| ("alt", a.as_str())));
            show_setup(app, &pairs);
        }
        "new" => new_chat(app),
        _ => show_main(app),
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart_on, None::<&str>)?;
    // a line of status, not a command: the hub in use, or how the one on this computer is doing
    let hub_line = MenuItem::with_id(app, "hub_line", "Hub", false, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &hub_line,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "new_chat", "New chat", true, None::<&str>)?,
            &MenuItem::with_id(app, "toggle", "Show/Hide", true, None::<&str>)?,
            &MenuItem::with_id(app, "quick", "Quick ask", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?,
            &MenuItem::with_id(app, "pair_phone", "Pair a phone...", true, None::<&str>)?,
            &MenuItem::with_id(app, "change_hub", "Change hub...", true, None::<&str>)?,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
        ],
    )?;
    *state(app).autostart_item.lock().unwrap() = Some(autostart);
    *state(app).hub_line.lock().unwrap() = Some(hub_line);
    *state(app).menu.lock().unwrap() = Some(menu.clone());
    update_tray_line(app);

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Conclave")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new_chat" => new_chat(app),
            "toggle" => toggle_main(app),
            "quick" => toggle_quick(app),
            "settings" => show_settings(app),
            "pair_phone" => show_pairing(app),
            "change_hub" => show_setup(app, &[]),
            "update" => install_update(app),
            "autostart" => {
                let on = !app.autolaunch().is_enabled().unwrap_or(false);
                if let Err(e) = apply_autostart(app, on) {
                    eprintln!("conclave: {e}");
                }
            }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // Must be first. A second launch focuses this one; deep links are forwarded.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == QUICK_ARG) {
                toggle_quick(app);
            } else {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        // the app's own updates, checked against the built-in key (update.rs)
        .plugin(update::plugin())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            connect,
            open_hub,
            set_autostart,
            computer_status,
            computer_enable,
            computer_disable,
            open_settings,
            local_hub_status,
            local_hub_set,
            local_hub_retry,
            local_hub_lan,
            local_hub_logs,
            pair_phone,
            open_remote_access,
            update_status,
            update_auto,
            update_install,
            terminal_status,
            terminal_install,
            terminal_remove,
            hub_people,
            login,
            login_confirm,
            login_cancel
        ])
        .on_window_event(|window, event| {
            // Closing a window hides it. Quit lives in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            app.manage(AppState {
                settings: Mutex::new(Settings::load(&settings_path)),
                settings_path,
                granted: Mutex::default(),
                autostart_item: Mutex::default(),
                daemon_lock: Mutex::default(),
                local_hub: local::Hub::default(),
                hub_line: Mutex::default(),
                quitting: AtomicBool::new(false),
                updates: Arc::default(),
                menu: Mutex::default(),
                update_item: Mutex::default(),
                terminal: terminal::Terminal::default(),
                pending_login: Mutex::default(),
            });

            let hidden = std::env::args().any(|a| a == HIDDEN_ARG);
            main_window(&handle, !hidden)?;
            build_tray(&handle)?;
            // an updated app brings a new daemon; the service moves to it
            refresh_daemon(&handle);
            // look for a new version of the app now and every 15 minutes; installed by itself when idle
            update::start(&handle, state(&handle).updates.clone(), Arc::new(UpdateHost(handle.clone())));
            // the AppImage adds itself to the app menu; a .deb or .rpm brings its own entry
            #[cfg(target_os = "linux")]
            appimage::integrate(&handle);
            // `conclave` in a terminal: set up on the first start and after an update, its login kept
            start_terminal(&handle, false);
            // the hub on this computer runs while the app does (started at login, too, when that is on)
            if state(&handle).settings.lock().unwrap().run_hub {
                if let Err(e) = start_local_hub(&handle) {
                    eprintln!("conclave: the hub on this computer: {e}");
                }
            }

            // Another app may own the shortcut already. That is not fatal.
            let shortcut = tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([QUICK_SHORTCUT])?
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_quick(app);
                    }
                })
                .build();
            if let Err(e) = handle.plugin(shortcut) {
                eprintln!("conclave: global shortcut {QUICK_SHORTCUT} unavailable: {e}");
            }

            // Installers register conclave:// on macOS and Windows. Linux (and
            // Windows dev builds) register at runtime.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("conclave: cannot register conclave:// links: {e}");
                }
            }
            let link_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&link_handle, &url);
                }
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_deep_link(&handle, &url);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting Conclave")
        .run(|app, event| {
            // Quit from the Dock or the system: the hub on this computer stops cleanly first.
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                let st = state(app);
                if st.local_hub.active() && !st.quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    quit(app);
                }
            }
            // macOS: clicking the Dock icon brings the window back.
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
                    show_main(app);
                }
            }
        });
}
