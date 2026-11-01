//! The Linux AppImage adds itself to the app menu (docs/INSTALL.md, Desktop
//! app). A .deb or .rpm ships its own menu entry; an AppImage is one file you
//! run from wherever you saved it, so on start it writes
//! $XDG_DATA_HOME/applications/conclave.desktop (~/.local/share when that is
//! unset) and its icon in the hicolor theme next to it.
//!
//! The entry carries X-Conclave-Managed=true. An entry without that line is
//! yours and stays as it is. The app writes the entry again only when it is
//! missing or its Exec names another path (the AppImage moved). Start at login
//! follows the AppImage the same way (refresh_autostart).

use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt as _;

/// The menu entry's file name in applications/.
const DESKTOP_FILE: &str = "conclave.desktop";
/// The key that says the app wrote the entry and may write it again.
const MANAGED_KEY: &str = "X-Conclave-Managed";
/// GTK names the window after the program (argv[0]), which is mainBinaryName
/// in tauri.conf.json. Tauri's own .deb entry uses the same StartupWMClass.
const WM_CLASS: &str = "conclave-desktop";
/// The bundled icons by hicolor size; the entry's Icon is the largest.
const ICONS: [(&str, &[u8]); 2] = [
    ("256x256", include_bytes!("../icons/128x128@2x.png")),
    ("512x512", include_bytes!("../icons/icon.png")),
];

/// The AppImage this process runs from: APPIMAGE, when this executable sits
/// inside APPDIR (the AppImage's mount, or where it was extracted). A .deb
/// or .rpm install has neither; an APPIMAGE inherited from another AppImage
/// (started from its terminal) has an APPDIR this executable is not in.
pub fn appimage_path(appimage: Option<OsString>, appdir: Option<OsString>, exe: &Path) -> Option<PathBuf> {
    let image = PathBuf::from(appimage?);
    let dir = PathBuf::from(appdir?);
    (image.is_absolute() && dir.is_absolute() && exe.starts_with(&dir)).then_some(image)
}

/// Where menu entries and icons go: XDG_DATA_HOME, or ~/.local/share when it
/// is unset, empty or relative (the XDG spec ignores relative paths).
pub fn data_home(xdg_data_home: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    if let Some(dir) = xdg_data_home.map(PathBuf::from).filter(|d| d.is_absolute()) {
        return Some(dir);
    }
    let home = home.map(PathBuf::from).filter(|h| h.is_absolute())?;
    Some(home.join(".local").join("share"))
}

/// An icon file in the hicolor theme under the data folder.
fn icon_file(data: &Path, size: &str) -> PathBuf {
    data.join("icons").join("hicolor").join(size).join("apps").join("conclave.png")
}

/// The icon the entry names: the largest.
pub fn icon_path(data: &Path) -> PathBuf {
    icon_file(data, ICONS[ICONS.len() - 1].0)
}

/// A desktop-entry string value: a backslash is written twice.
fn escape_value(s: &str) -> String {
    s.replace('\\', "\\\\")
}

/// The Exec value: the AppImage path in double quotes, then %u for
/// conclave:// links. Inside the quotes " ` $ and \ take a backslash, the
/// string value then doubles every backslash, and a literal % is %%.
pub fn exec_value(path: &str) -> String {
    let mut quoted = String::with_capacity(path.len() + 2);
    for c in path.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    format!("\"{}\" %u", escape_value(&quoted).replace('%', "%%"))
}

/// The menu entry for the AppImage at `appimage` with its icon at `icon`.
pub fn entry(appimage: &str, icon: &str) -> String {
    format!(
        "# Written by Conclave on start while it runs as an AppImage. Remove the\n\
         # {MANAGED_KEY} line to keep your own changes to this file.\n\
         [Desktop Entry]\n\
         Type=Application\n\
         Name=Conclave\n\
         Exec={exec}\n\
         Icon={icon}\n\
         Terminal=false\n\
         Categories=Development;Utility;\n\
         MimeType=x-scheme-handler/conclave;\n\
         StartupWMClass={WM_CLASS}\n\
         {MANAGED_KEY}=true\n",
        exec = exec_value(appimage),
        icon = escape_value(icon),
    )
}

/// A key's value in the [Desktop Entry] group, as written in the file.
pub fn desktop_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let mut in_entry = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
        } else if in_entry && !line.starts_with('#') {
            if let Some((k, v)) = line.split_once('=') {
                if k.trim_end() == key {
                    return Some(v.trim_start());
                }
            }
        }
    }
    None
}

/// What to do with the menu entry.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// Missing, or the app's own entry names another path.
    Write,
    /// The app's own entry already runs this AppImage.
    Keep,
    /// No X-Conclave-Managed=true: the user's own entry, left alone.
    UserOwned,
}

/// Decide from the entry on disk (None when there is none) and the AppImage
/// this process runs from.
pub fn plan(existing: Option<&str>, appimage: &str) -> Plan {
    let Some(text) = existing else { return Plan::Write };
    if desktop_value(text, MANAGED_KEY) != Some("true") {
        return Plan::UserOwned;
    }
    if desktop_value(text, "Exec") == Some(exec_value(appimage).as_str()) {
        Plan::Keep
    } else {
        Plan::Write
    }
}

/// Whether the Start at login entry runs something other than this AppImage:
/// it moved, or an older entry named the temporary mount (/tmp/.mount_*).
/// The autostart plugin writes `Exec=<path> --hidden`, unquoted.
pub fn autostart_stale(text: &str, appimage: &str) -> bool {
    match desktop_value(text, "Exec") {
        Some(exec) => exec != appimage && !exec.starts_with(&format!("{appimage} ")),
        None => true,
    }
}

/// On start, on Linux: the menu entry and Start at login for the AppImage.
/// Nothing happens for a .deb or .rpm install.
pub fn integrate(app: &AppHandle) {
    let Ok(exe) = std::env::current_exe() else { return };
    // the mount point as the kernel names it, like current_exe
    let appdir = std::env::var_os("APPDIR").map(|d| fs::canonicalize(&d).map(PathBuf::into_os_string).unwrap_or(d));
    let Some(image) = appimage_path(std::env::var_os("APPIMAGE"), appdir, &exe) else { return };
    // a desktop entry holds one line per key, in UTF-8
    let Some(image) = image.to_str().filter(|p| !p.contains(['\n', '\r'])).map(str::to_owned) else { return };
    let app = app.clone();
    std::thread::spawn(move || {
        match data_home(std::env::var_os("XDG_DATA_HOME"), std::env::var_os("HOME")) {
            Some(data) => match menu_entry(&data, &image) {
                Ok(Plan::Write) => eprintln!("conclave: added Conclave to the app menu ({image})"),
                Ok(_) => {}
                Err(e) => eprintln!("conclave: app menu entry: {e}"),
            },
            None => eprintln!("conclave: app menu entry: HOME and XDG_DATA_HOME are not set"),
        }
        refresh_autostart(&app, &image);
    });
}

/// Writes the menu entry and its icons under the data folder as the plan
/// says, and returns the plan.
fn menu_entry(data: &Path, image: &str) -> Result<Plan, String> {
    let dir = data.join("applications");
    let file = dir.join(DESKTOP_FILE);
    let existing = fs::read_to_string(&file).ok();
    let plan = plan(existing.as_deref(), image);
    if plan == Plan::UserOwned {
        return Ok(plan);
    }
    // the icons, also when an update brought new ones
    for (size, bytes) in ICONS {
        let path = icon_file(data, size);
        if fs::read(&path).ok().as_deref() != Some(bytes) {
            fs::create_dir_all(path.parent().unwrap_or(data)).map_err(|e| e.to_string())?;
            fs::write(&path, bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        }
    }
    if plan == Plan::Keep {
        return Ok(plan);
    }
    let icon = icon_path(data);
    let icon = icon.to_str().ok_or("the data folder's path is not UTF-8")?;
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // menus watch the folder: a whole file appears at once
    let tmp = dir.join(format!(".{DESKTOP_FILE}.tmp"));
    fs::write(&tmp, entry(image, icon)).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, &file).map_err(|e| format!("{}: {e}", file.display()))?;
    // not every desktop has it; the menu finds the entry without it, too
    let _ = Command::new("update-desktop-database")
        .arg(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    Ok(plan)
}

/// Start at login already names the AppImage, not its mount: the autostart
/// plugin takes APPIMAGE on Linux. After the AppImage moved the entry still
/// names the old path, so it is written again with this one.
fn refresh_autostart(app: &AppHandle, image: &str) {
    let launcher = app.autolaunch();
    if !launcher.is_enabled().unwrap_or(false) {
        return;
    }
    let Some(home) = std::env::var_os("HOME") else { return };
    // where auto-launch keeps it: ~/.config/autostart/<productName>.desktop
    let file = Path::new(&home).join(".config").join("autostart").join(format!("{}.desktop", app.package_info().name));
    if fs::read_to_string(&file).is_ok_and(|text| autostart_stale(&text, image)) {
        if let Err(e) = launcher.enable() {
            eprintln!("conclave: start at login: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    #[test]
    fn entry_has_every_key() {
        let text = entry("/home/kai/Apps/Conclave.AppImage", "/home/kai/.local/share/icons/hicolor/512x512/apps/conclave.png");
        assert_eq!(
            text,
            "# Written by Conclave on start while it runs as an AppImage. Remove the\n\
             # X-Conclave-Managed line to keep your own changes to this file.\n\
             [Desktop Entry]\n\
             Type=Application\n\
             Name=Conclave\n\
             Exec=\"/home/kai/Apps/Conclave.AppImage\" %u\n\
             Icon=/home/kai/.local/share/icons/hicolor/512x512/apps/conclave.png\n\
             Terminal=false\n\
             Categories=Development;Utility;\n\
             MimeType=x-scheme-handler/conclave;\n\
             StartupWMClass=conclave-desktop\n\
             X-Conclave-Managed=true\n"
        );
    }

    #[test]
    fn exec_quotes_and_escapes_the_path() {
        assert_eq!(exec_value("/home/kai/My Apps/Conclave.AppImage"), "\"/home/kai/My Apps/Conclave.AppImage\" %u");
        // $ and " take a backslash inside quotes, which the file then doubles
        assert_eq!(exec_value("/a/$x\"y"), "\"/a/\\\\$x\\\\\"y\" %u");
        // a backslash becomes \\ in quotes, \\\\ in the file
        assert_eq!(exec_value("/a\\b"), "\"/a\\\\\\\\b\" %u");
        assert_eq!(exec_value("/a/100%"), "\"/a/100%%\" %u");
    }

    #[test]
    fn icon_is_the_largest_under_hicolor() {
        assert_eq!(
            icon_path(Path::new("/home/kai/.local/share")),
            PathBuf::from("/home/kai/.local/share/icons/hicolor/512x512/apps/conclave.png")
        );
    }

    #[test]
    fn missing_entry_is_written() {
        assert_eq!(plan(None, "/home/kai/Conclave.AppImage"), Plan::Write);
    }

    #[test]
    fn own_entry_for_this_path_is_kept() {
        for path in ["/home/kai/Conclave.AppImage", "/home/kai/My Apps/Con$clave 100%.AppImage"] {
            let text = entry(path, "/icon.png");
            assert_eq!(plan(Some(&text), path), Plan::Keep, "{path}");
        }
    }

    #[test]
    fn own_entry_for_another_path_is_rewritten() {
        let text = entry("/home/kai/Downloads/Conclave_0.1.0_amd64.AppImage", "/icon.png");
        assert_eq!(plan(Some(&text), "/home/kai/Apps/Conclave.AppImage"), Plan::Write);
        // never the temporary mount
        let mount = entry("/tmp/.mount_ConclaAbCdEf/usr/bin/conclave-desktop", "/icon.png");
        assert_eq!(plan(Some(&mount), "/home/kai/Apps/Conclave.AppImage"), Plan::Write);
    }

    #[test]
    fn entry_without_the_marker_is_left_alone() {
        let hand = "[Desktop Entry]\nType=Application\nName=Conclave\nExec=/home/kai/old/Conclave.AppImage\nIcon=conclave\n";
        assert_eq!(plan(Some(hand), "/home/kai/Apps/Conclave.AppImage"), Plan::UserOwned);
        let off = entry("/home/kai/old/Conclave.AppImage", "/icon.png").replace("X-Conclave-Managed=true", "X-Conclave-Managed=false");
        assert_eq!(plan(Some(&off), "/home/kai/Apps/Conclave.AppImage"), Plan::UserOwned);
        // the marker counts only in [Desktop Entry]
        let elsewhere = format!("{hand}[Desktop Action x]\nX-Conclave-Managed=true\n");
        assert_eq!(plan(Some(&elsewhere), "/home/kai/Apps/Conclave.AppImage"), Plan::UserOwned);
    }

    #[test]
    fn desktop_value_reads_only_the_entry_group() {
        let text = "# Exec=/commented\n[Desktop Entry]\nTryExec=/try\nExec = \"/a\" %u\n[Desktop Action new]\nExec=/other\n";
        assert_eq!(desktop_value(text, "Exec"), Some("\"/a\" %u"));
        assert_eq!(desktop_value(text, "TryExec"), Some("/try"));
        assert_eq!(desktop_value(text, "Icon"), None);
    }

    #[test]
    fn data_home_prefers_xdg_data_home() {
        assert_eq!(data_home(os("/data"), os("/home/kai")), Some(PathBuf::from("/data")));
        assert_eq!(data_home(None, os("/home/kai")), Some(PathBuf::from("/home/kai/.local/share")));
        // empty or relative XDG_DATA_HOME is ignored
        assert_eq!(data_home(os(""), os("/home/kai")), Some(PathBuf::from("/home/kai/.local/share")));
        assert_eq!(data_home(os("data"), os("/home/kai")), Some(PathBuf::from("/home/kai/.local/share")));
        assert_eq!(data_home(None, None), None);
        assert_eq!(data_home(None, os("")), None);
    }

    #[test]
    fn appimage_only_when_running_inside_it() {
        let exe = Path::new("/tmp/.mount_ConclaAbCdEf/usr/bin/conclave-desktop");
        assert_eq!(
            appimage_path(os("/home/kai/Apps/Conclave.AppImage"), os("/tmp/.mount_ConclaAbCdEf"), exe),
            Some(PathBuf::from("/home/kai/Apps/Conclave.AppImage"))
        );
        // .deb or .rpm: no AppImage variables
        assert_eq!(appimage_path(None, None, Path::new("/usr/bin/conclave-desktop")), None);
        // inherited from another AppImage's terminal
        assert_eq!(
            appimage_path(os("/home/kai/Apps/Editor.AppImage"), os("/tmp/.mount_EditorXyZ"), Path::new("/usr/bin/conclave-desktop")),
            None
        );
        assert_eq!(appimage_path(os("Conclave.AppImage"), os("/tmp/.mount_ConclaAbCdEf"), exe), None);
        assert_eq!(appimage_path(os("/home/kai/Apps/Conclave.AppImage"), None, exe), None);
    }

    #[test]
    fn writes_the_entry_and_icons_and_leaves_yours_alone() {
        let data = std::env::temp_dir().join(format!("conclave-desktop-appimage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let file = data.join("applications").join(DESKTOP_FILE);
        let first = "/home/kai/Downloads/Conclave.AppImage";
        assert_eq!(menu_entry(&data, first), Ok(Plan::Write));
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text, entry(first, icon_path(&data).to_str().unwrap()));
        for (size, bytes) in ICONS {
            assert_eq!(fs::read(icon_file(&data, size)).unwrap(), bytes);
        }
        assert!(!data.join("applications").join(format!(".{DESKTOP_FILE}.tmp")).exists());
        // the same path again: nothing to write
        assert_eq!(menu_entry(&data, first), Ok(Plan::Keep));
        // the AppImage moved
        let moved = "/home/kai/Apps/Conclave.AppImage";
        assert_eq!(menu_entry(&data, moved), Ok(Plan::Write));
        assert_eq!(desktop_value(&fs::read_to_string(&file).unwrap(), "Exec"), Some("\"/home/kai/Apps/Conclave.AppImage\" %u"));
        // your own entry stays as it is
        let yours = "[Desktop Entry]\nType=Application\nName=Conclave\nExec=/opt/Conclave.AppImage\n";
        fs::write(&file, yours).unwrap();
        assert_eq!(menu_entry(&data, moved), Ok(Plan::UserOwned));
        assert_eq!(fs::read_to_string(&file).unwrap(), yours);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn autostart_follows_the_appimage() {
        let image = "/home/kai/Apps/Conclave.AppImage";
        let current = format!("[Desktop Entry]\nType=Application\nName=Conclave\nExec={image} --hidden\n");
        assert!(!autostart_stale(&current, image));
        assert!(autostart_stale("[Desktop Entry]\nExec=/home/kai/Downloads/Conclave.AppImage --hidden\n", image));
        assert!(autostart_stale("[Desktop Entry]\nExec=/tmp/.mount_ConclaAbCdEf/usr/bin/conclave-desktop --hidden\n", image));
        assert!(autostart_stale(&format!("[Desktop Entry]\nExec={image}.old --hidden\n"), image));
    }
}
