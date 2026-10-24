//! Updates of the app itself (docs/DESIGN.md, Updates). The Tauri updater
//! plugin reads latest.json on the public releases, which Publish public
//! writes with each desktop bundle's minisign signature, and checks the
//! download against the key in packages/core/src/update/update-key.pub (the
//! one file every Conclave updater reads, built in here). It looks on start
//! and every 15 minutes; a newer version puts "Update to X and restart" in the
//! tray menu and in the app's settings page. With "Install updates
//! automatically" on (the default), it installs by itself once two checks in a
//! row find nothing running (Host::idle). An install that fails is not tried
//! again until a newer version; a permission error also says so in a
//! notification, and the tray item stays for the owner to click.
//!
//! While that file holds the placeholder there is nothing to check against,
//! so the app shows nothing and says why in its log. A Linux install from the
//! .deb or .rpm is updated by the package manager, not here: only the
//! AppImage updates itself. The hub the app runs and the daemon it carries
//! come with the new app (local.rs, computer.rs).

use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// The update key file, built in.
const KEY_FILE: &str = include_str!("../../../core/src/update/update-key.pub");
/// Look again after this long.
const EVERY: Duration = Duration::from_secs(15 * 60);

/// The last line that is not empty or a # comment.
pub fn key_line(text: &str) -> &str {
    text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).last().unwrap_or("")
}

/// The key as the updater plugin wants it (base64 of a whole minisign key
/// file), or why updates are off.
pub fn tauri_pubkey(text: &str) -> Result<String, String> {
    use base64::Engine;
    let line = key_line(text);
    if line.is_empty() || line.eq_ignore_ascii_case("placeholder") {
        return Err("this build has no update key yet (packages/core/src/update/update-key.pub is the placeholder)".into());
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let decoded = b64.decode(line).map_err(|_| "the update key is not base64".to_string())?;
    let text = String::from_utf8_lossy(&decoded);
    if text.trim_start().to_ascii_lowercase().starts_with("untrusted comment:") {
        return Ok(line.to_string());
    }
    // a bare RWQ... line: wrap it in the key file the plugin decodes
    if decoded.len() == 42 {
        return Ok(b64.encode(format!("untrusted comment: minisign public key\n{line}\n")));
    }
    Err("the update key is not a minisign public key".into())
}

/// Why this copy cannot update itself, when it cannot.
fn off_reason() -> Option<String> {
    if let Err(e) = tauri_pubkey(KEY_FILE) {
        return Some(e);
    }
    if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none() {
        return Some("installed from a .deb or .rpm: install the new package from the releases page to update".into());
    }
    if tauri::is_dev() {
        return Some("a development build".into());
    }
    None
}

/// The plugin, with the built-in key. Registered always (its config needs a
/// key string); nothing checks while updates are off.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
    let mut b = tauri_plugin_updater::Builder::new();
    if let Ok(key) = tauri_pubkey(KEY_FILE) {
        b = b.pubkey(key);
    }
    b.build()
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// The version an update would bring.
    pub available: Option<String>,
    pub notes: Option<String>,
    /// Downloading or installing now.
    pub installing: bool,
    /// The last check or install failed: why.
    pub error: Option<String>,
    /// Updates are off here: why.
    pub off: Option<String>,
    pub current: String,
}

#[derive(Default)]
pub struct Updates {
    view: Mutex<View>,
    /// The version an automatic install failed on: not tried again by itself.
    failed: Mutex<Option<String>>,
}

impl Updates {
    pub fn view(&self) -> View {
        self.view.lock().unwrap().clone()
    }

    fn set(&self, f: impl FnOnce(&mut View)) -> View {
        let mut v = self.view.lock().unwrap();
        f(&mut v);
        v.clone()
    }
}

/// What the app does when an update shows up or changes: the tray item.
pub trait Host: Send + Sync + 'static {
    fn changed(&self, view: &View);
    /// "Install updates automatically" is on.
    fn auto(&self) -> bool;
    /// Nothing runs that an install would cut off. Blocking.
    fn idle(&self) -> bool;
    /// Install now and restart (returns only when the install failed). Blocking.
    fn install(&self) -> Result<(), String>;
    /// The install needs the owner: say so once.
    fn notify(&self, version: &str);
}

/// Worth asking whether the app is idle: auto-install is on and the version
/// waiting is not one that failed before.
fn wants_auto(auto: bool, available: Option<&str>, failed: Option<&str>) -> bool {
    auto && available.is_some() && available != failed
}

/// The install failed because this user cannot write the app (macOS app not
/// writable, Windows per-machine install): only the owner can do it.
fn permission_error(e: &str) -> bool {
    let e = e.to_ascii_lowercase();
    ["permission denied", "access is denied", "operation not permitted", "read-only file system", "requires elevation", "(os error 1)", "(os error 5)", "(os error 13)"]
        .iter()
        .any(|w| e.contains(w))
}

/// Check now, then every 15 minutes, on a thread of its own. Returns at once.
pub fn start<R: Runtime>(app: &AppHandle<R>, updates: Arc<Updates>, host: Arc<dyn Host>) {
    let current = app.package_info().version.to_string();
    if let Some(why) = off_reason() {
        eprintln!("conclave: updates are off: {why}");
        updates.set(|v| {
            v.off = Some(why);
            v.current = current;
        });
        return;
    }
    updates.set(|v| v.current = current);
    let app = app.clone();
    std::thread::spawn(move || {
        // the last check found the app idle too: two in a row before an install
        let mut was_idle = false;
        loop {
            let view = tauri::async_runtime::block_on(check(&app, &updates));
            host.changed(&view);
            let failed = updates.failed.lock().unwrap().clone();
            let idle = wants_auto(host.auto(), view.available.as_deref(), failed.as_deref()) && host.idle();
            if idle && was_idle {
                was_idle = false;
                if let Err(e) = host.install() {
                    eprintln!("conclave: automatic update: {e}");
                    if let Some(version) = view.available.clone() {
                        if permission_error(&e) {
                            host.notify(&version);
                        }
                        *updates.failed.lock().unwrap() = Some(version);
                    }
                    host.changed(&updates.view());
                }
            } else {
                was_idle = idle;
            }
            std::thread::sleep(EVERY);
        }
    });
}

/// Ask the release server now.
pub async fn check<R: Runtime>(app: &AppHandle<R>, updates: &Updates) -> View {
    let result = match app.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    match result {
        Ok(Some(u)) => updates.set(|v| {
            v.available = Some(u.version.clone());
            v.notes = u.body.clone();
            v.error = None;
        }),
        Ok(None) => updates.set(|v| {
            v.available = None;
            v.error = None;
        }),
        Err(e) => {
            // a release without a desktop bundle for this system is not an error people need to see
            eprintln!("conclave: update check: {e}");
            updates.set(|v| v.error = Some(e))
        }
    }
}

/// Download, check the signature, install, and start the new version.
/// `before_restart` stops what must stop cleanly first (the hub on this computer).
pub async fn install<R: Runtime>(app: &AppHandle<R>, updates: &Updates, before_restart: impl FnOnce() + Send + 'static) -> Result<(), String> {
    if let Some(why) = updates.view().off {
        return Err(format!("Updates are off: {why}."));
    }
    if updates.view().installing {
        return Err("An update is already installing.".into());
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else {
        updates.set(|v| v.available = None);
        return Err("This is the newest version.".into());
    };
    updates.set(|v| {
        v.installing = true;
        v.error = None;
    });
    // the plugin checks the minisign signature of the download before it installs anything
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        let msg = format!("The update did not install: {e}");
        updates.set(|v| {
            v.installing = false;
            v.error = Some(msg.clone());
        });
        return Err(msg);
    }
    // Windows: the installer already closed the app. macOS and Linux: start the new one
    let app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(before_restart).await;
    app.restart();
}

/// Words for the tray item and the settings page.
pub fn words(v: &View) -> Option<String> {
    v.available.as_ref().map(|ver| format!("Update to {ver} and restart"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAURI_PUB: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM0NkJEQjQ3MEM2Q0MxQUQKUldTdHdXd01SOXRyTkZwNE84WHF0Rmk0UUMrWHZxK3FiOGdzYnZwQ3pIWkM1dVYySTVITmhJckMK";

    #[test]
    fn the_key_comes_from_the_last_line_and_the_placeholder_turns_updates_off() {
        assert_eq!(tauri_pubkey(&format!("# comment\n{TAURI_PUB}\n")).unwrap(), TAURI_PUB);
        assert!(tauri_pubkey("# comment\nPLACEHOLDER\n").unwrap_err().contains("no update key"));
        assert!(tauri_pubkey("not base64 !!").is_err());
        // the bare key line is wrapped into a key file
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let text = String::from_utf8(b64.decode(TAURI_PUB).unwrap()).unwrap();
        let bare = text.lines().nth(1).unwrap();
        let wrapped = String::from_utf8(b64.decode(tauri_pubkey(bare).unwrap()).unwrap()).unwrap();
        assert!(wrapped.starts_with("untrusted comment:") && wrapped.contains(bare));
        // the committed file: off while it is the placeholder
        assert_eq!(tauri_pubkey(KEY_FILE).is_err(), key_line(KEY_FILE).eq_ignore_ascii_case("placeholder"));
    }

    #[test]
    fn auto_install_skips_a_failed_version_until_the_next() {
        assert!(wants_auto(true, Some("0.5.0"), None));
        assert!(!wants_auto(false, Some("0.5.0"), None));
        assert!(!wants_auto(true, None, None));
        assert!(!wants_auto(true, Some("0.5.0"), Some("0.5.0")));
        assert!(wants_auto(true, Some("0.5.1"), Some("0.5.0")));
    }

    #[test]
    fn permission_errors() {
        assert!(permission_error("The update did not install: Permission denied (os error 13)"));
        assert!(permission_error("The update did not install: Access is denied. (os error 5)"));
        assert!(!permission_error("The update did not install: signature mismatch"));
        assert!(!permission_error("connection reset (os error 104)"));
    }

    #[test]
    fn the_words() {
        assert_eq!(words(&View::default()), None);
        assert_eq!(words(&View { available: Some("0.5.0".into()), ..Default::default() }).as_deref(), Some("Update to 0.5.0 and restart"));
    }
}
