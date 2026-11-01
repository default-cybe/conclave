//! The `conclave` command in a terminal (docs/INSTALL.md, section 5, The
//! terminal command).
//!
//! The app already gets the `conclave` CLI of its own version for the hub on
//! this computer (local.rs): the whole CLI, with the terminal app (`conclave`,
//! `conclave chat`), `run`, `login` and the rest. On its first start, after
//! each update of the app, and on Reinstall in its Settings, it puts that CLI
//! on the PATH:
//!
//! - Linux and macOS: `~/.local/bin/conclave`, a symlink to
//!   `<data>/bin/conclave`, which is a symlink to the binary of the version in
//!   `<data>/hub-bin`. An update points `<data>/bin/conclave` at the new
//!   version in one step and leaves `~/.local/bin` alone. When the shell a
//!   new terminal window opens has no `~/.local/bin` on its PATH, one line
//!   ending in `# added by Conclave` goes into its startup file: zsh
//!   `.zprofile` on macOS and `.zshrc` on Linux, bash `.bash_profile` (or the
//!   `.bash_login` or `.profile` it reads) on macOS and `.bashrc` on Linux,
//!   fish `conf.d/conclave.fish`, sh `.profile`. Never anything in
//!   /usr/local/bin.
//! - Windows: a copy of conclave.exe (a hard link when it can) in
//!   `%LOCALAPPDATA%\Conclave\bin` with `added-by-conclave.txt` next to it,
//!   and that folder on the user's PATH (HKCU\Environment, winpath.rs),
//!   announced with WM_SETTINGCHANGE.
//!
//! A `conclave` the app did not make stays as it is: install.sh's link at
//! the same place, or any other on the PATH. Remove deletes only what carries
//! the app's mark: a link that names `<data>/bin/conclave`, lines ending in
//! `# added by Conclave`, a copy with its note, and a login with
//! `"managedBy": "conclave-desktop"`.
//!
//! The login: `conclave` from the link talks to the hub the app uses with no
//! `conclave login`. The app pairs a client of its own for it (the way a phone
//! pairs, hub::pair_terminal) and writes `~/.conclave/client.json` as
//! `conclave login` does, plus the mark. Only where there is no login yet, and
//! not when the CLI has a hub of its own (`~/.conclave/config.json`); a
//! login you made (`conclave login`) is yours, and after `conclave logout`
//! the app does not write one again until Reinstall.
//!
//! What decides is in pure functions with tests at the end.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Url;

#[cfg(windows)]
use crate::winpath;

/// The end of every line the app adds to a shell's startup file.
pub const MARK: &str = "# added by Conclave";
/// client.json's mark: the app wrote this login.
pub const MANAGED_BY: &str = "conclave-desktop";
/// The command's file.
pub const EXE: &str = if cfg!(windows) { "conclave.exe" } else { "conclave" };
/// Windows: the note next to the app's copy (an .exe cannot carry a mark).
pub const NOTE: &str = "added-by-conclave.txt";
/// What the note starts with.
#[cfg_attr(not(windows), allow(dead_code))]
const NOTE_HEAD: &str = "Added by the Conclave desktop app. Settings, Terminal command, Remove takes it away.";
/// Windows: the names a `conclave` on the PATH can have.
const WIN_NAMES: &[&str] = &["conclave.exe", "conclave.cmd", "conclave.bat", "conclave.com"];

// ---------------------------------------------------------------------------
// Saved state (settings.json, "terminal")
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    /// The app version the command was last set up for. Another one (an
    /// update, the first start) sets it up again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The owner pressed Remove: nothing comes back until Reinstall.
    #[serde(default, skip_serializing_if = "crate::hub::is_false")]
    pub removed: bool,
    /// The client the app signed the command in as (client.json). Set: the
    /// app wrote a login once, so a missing one was logged out on purpose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
}

impl Saved {
    pub fn is_empty(&self) -> bool {
        *self == Saved::default()
    }
}

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Paths {
    /// The user's home folder.
    pub home: PathBuf,
    /// The app's local data folder: hub-bin, and bin/conclave.
    pub data: PathBuf,
    /// The folder the command goes in: ~/.local/bin, or %LOCALAPPDATA%\Conclave\bin.
    pub bin_dir: PathBuf,
    /// bin_dir as the page shows it: ~/.local/bin, %LOCALAPPDATA%\Conclave\bin.
    pub bin_shown: String,
    /// The CLI's home ($CONCLAVE_HOME or ~/.conclave): client.json and config.json.
    pub cli_home: PathBuf,
}

impl Paths {
    /// `local_app_data`: %LOCALAPPDATA% (Windows only).
    pub fn new(home: PathBuf, data: PathBuf, local_app_data: Option<PathBuf>, conclave_home: Option<PathBuf>) -> Paths {
        let cli_home = conclave_home.filter(|h| h.is_absolute()).unwrap_or_else(|| home.join(".conclave"));
        let (bin_dir, bin_shown) = match local_app_data.filter(|_| cfg!(windows)) {
            Some(local) => (local.join("Conclave").join("bin"), r"%LOCALAPPDATA%\Conclave\bin".to_string()),
            None => (home.join(".local").join("bin"), "~/.local/bin".to_string()),
        };
        Paths { home, data, bin_dir, bin_shown, cli_home }
    }

    /// Where `conclave` goes.
    pub fn link(&self) -> PathBuf {
        self.bin_dir.join(EXE)
    }

    pub fn link_shown(&self) -> String {
        format!("{}{}{EXE}", self.bin_shown, if cfg!(windows) { "\\" } else { "/" })
    }

    /// Linux and macOS: what the link names, pointed at each version in turn.
    pub fn stable(&self) -> PathBuf {
        self.data.join("bin").join(EXE)
    }

    /// Windows: the note that marks the copy as the app's.
    pub fn note(&self) -> PathBuf {
        self.bin_dir.join(NOTE)
    }

    pub fn client(&self) -> PathBuf {
        self.cli_home.join("client.json")
    }

    /// A path for the page: ~ for the home folder.
    pub fn shown(&self, path: &Path) -> String {
        match path.strip_prefix(&self.home) {
            Ok(rest) if !cfg!(windows) => format!("~/{}", rest.display()),
            _ => path.display().to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// What is there, and what to do
// ---------------------------------------------------------------------------

/// What the place of the command holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AtLink {
    Missing,
    /// The app's: a link to `<data>/bin/conclave`, or a copy with the app's note.
    Ours,
    /// install.sh's link into its release folder (`~/.local/share/conclave/conclave`).
    Script,
    /// Anything else.
    Foreign,
}

/// Linux and macOS: what is at `link`. `target`: where a symlink there points
/// (None: no symlink); `exists`: anything is there, also a broken symlink.
#[cfg_attr(windows, allow(dead_code))]
pub fn classify(link: &Path, target: Option<&Path>, exists: bool, stable: &Path) -> AtLink {
    if !exists {
        return AtLink::Missing;
    }
    let Some(target) = target else { return AtLink::Foreign };
    let target = if target.is_absolute() { target.to_path_buf() } else { link.parent().unwrap_or(Path::new("/")).join(target) };
    let named = |p: Option<&Path>| p.and_then(Path::file_name).and_then(|n| n.to_str()).map(str::to_string);
    if target == stable {
        AtLink::Ours
    } else if named(Some(&target)).as_deref() == Some("conclave") && named(target.parent()).as_deref() == Some("conclave") {
        // install.sh: <CONCLAVE_INSTALL_DIR, ~/.local/share/conclave>/conclave
        AtLink::Script
    } else {
        AtLink::Foreign
    }
}

/// Windows: a copy is the app's when the note is next to it.
pub fn classify_copy(exe_exists: bool, note_exists: bool) -> AtLink {
    match (exe_exists, note_exists) {
        (false, _) => AtLink::Missing,
        (true, true) => AtLink::Ours,
        (true, false) => AtLink::Foreign,
    }
}

/// What is at the place of the command now.
pub fn at_link(paths: &Paths) -> AtLink {
    let link = paths.link();
    if cfg!(windows) {
        return classify_copy(link.is_file(), paths.note().is_file());
    }
    let exists = fs::symlink_metadata(&link).is_ok();
    classify(&link, fs::read_link(&link).ok().as_deref(), exists, &paths.stable())
}

/// The first `conclave` on `path` (entries split by `sep`) that the app did
/// not make. `found`: a command file is there; `ours`: it is the app's own.
pub fn foreign_on_path(path: &str, sep: char, names: &[&str], found: &dyn Fn(&Path) -> bool, ours: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    path.split(sep)
        .map(|d| d.trim().trim_matches('"'))
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .filter(|d| d.is_absolute())
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| found(p) && !ours(p))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Make the link (or the copy).
    Link,
    /// The app's own is there: only the version follows.
    Keep,
    /// install.sh's link: left as it is.
    Script,
    /// A `conclave` the app did not make, at its place or elsewhere on the PATH.
    Foreign(PathBuf),
    /// Removed in Settings: nothing until Reinstall.
    Removed,
}

/// `foreign`: another `conclave` on the PATH (looked for only when the place is free).
/// `forced`: Reinstall.
pub fn plan(at: &AtLink, link: &Path, foreign: Option<&Path>, removed: bool, forced: bool) -> Plan {
    match at {
        AtLink::Ours => Plan::Keep,
        AtLink::Script => Plan::Script,
        AtLink::Foreign => Plan::Foreign(link.to_path_buf()),
        AtLink::Missing if removed && !forced => Plan::Removed,
        AtLink::Missing => match foreign {
            Some(other) => Plan::Foreign(other.to_path_buf()),
            None => Plan::Link,
        },
    }
}

// ---------------------------------------------------------------------------
// The PATH, and the shell's startup file (Linux and macOS)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shell {
    Zsh,
    Bash,
    Fish,
    /// sh, dash, ksh: ~/.profile.
    Sh,
    /// csh, tcsh, nu and the rest: the app does not edit their files.
    Other,
}

/// The kind of shell from $SHELL.
pub fn shell_kind(shell: &str) -> Shell {
    let name = shell.rsplit(['/', '\\']).next().unwrap_or("").trim_start_matches('-');
    match name {
        "zsh" => Shell::Zsh,
        "bash" => Shell::Bash,
        "fish" => Shell::Fish,
        "sh" | "dash" | "ash" | "ksh" | "mksh" => Shell::Sh,
        _ => Shell::Other,
    }
}

/// Whether `dir` is an entry of a `:` PATH (with ~ for `home`).
#[cfg_attr(windows, allow(dead_code))]
pub fn dir_on_path(path: &str, dir: &Path, home: &Path) -> bool {
    path.split(':').map(str::trim).filter(|e| !e.is_empty()).any(|e| {
        let entry = match e.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None if e == "~" => home.to_path_buf(),
            None => PathBuf::from(e),
        };
        entry == dir
    })
}

/// The startup file a new terminal window reads, for the PATH line. macOS
/// terminals open login shells; on Linux they open interactive ones.
/// `zdotdir`: $ZDOTDIR; `config`: $XDG_CONFIG_HOME.
#[cfg_attr(windows, allow(dead_code))]
pub fn rc_file(shell: Shell, macos: bool, home: &Path, zdotdir: Option<&Path>, config: Option<&Path>, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    match shell {
        Shell::Zsh => Some(zdotdir.filter(|d| d.is_absolute()).unwrap_or(home).join(if macos { ".zprofile" } else { ".zshrc" })),
        // a login bash reads the first of these that exists: making .bash_profile next to a .profile would hide the .profile
        Shell::Bash if macos => Some([".bash_profile", ".bash_login", ".profile"].iter().map(|f| home.join(f)).find(|p| exists(p)).unwrap_or_else(|| home.join(".bash_profile"))),
        Shell::Bash => Some(home.join(".bashrc")),
        Shell::Fish => Some(fish_file(home, config)),
        Shell::Sh => Some(home.join(".profile")),
        Shell::Other => None,
    }
}

#[cfg_attr(windows, allow(dead_code))]
fn fish_file(home: &Path, config: Option<&Path>) -> PathBuf {
    config.filter(|c| c.is_absolute()).map(Path::to_path_buf).unwrap_or_else(|| home.join(".config")).join("fish").join("conf.d").join("conclave.fish")
}

/// Every file the app may have added a line to, for Remove.
#[cfg_attr(windows, allow(dead_code))]
pub fn rc_files(home: &Path, zdotdir: Option<&Path>, config: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let zdot = zdotdir.filter(|d| d.is_absolute());
    for dir in zdot.into_iter().chain(Some(home)) {
        for f in [".zprofile", ".zshrc"] {
            out.push(dir.join(f));
        }
    }
    for f in [".bash_profile", ".bash_login", ".profile", ".bashrc"] {
        out.push(home.join(f));
    }
    out.push(fish_file(home, config));
    let mut seen: Vec<PathBuf> = Vec::new();
    out.retain(|p| {
        let first = !seen.contains(p);
        seen.push(p.clone());
        first
    });
    out
}

/// The one line that puts `dir` on the PATH, with the mark.
#[cfg_attr(windows, allow(dead_code))]
pub fn path_line(shell: Shell, dir: &Path, home: &Path) -> String {
    let dir = match dir.strip_prefix(home) {
        Ok(rest) => format!("$HOME/{}", rest.display()),
        Err(_) => dir.display().to_string(),
    };
    match shell {
        Shell::Fish => format!("contains -- \"{dir}\" $PATH; or set -gx PATH \"{dir}\" $PATH {MARK}"),
        _ => format!("export PATH=\"{dir}:$PATH\" {MARK}"),
    }
}

#[cfg_attr(windows, allow(dead_code))]
fn is_marked(line: &str) -> bool {
    line.trim_end().ends_with(MARK)
}

/// The text with `line` at its end, or None when it has it already. Another
/// line of the app's (an older one) goes, so there is only ever one.
#[cfg_attr(windows, allow(dead_code))]
pub fn with_line(text: &str, line: &str) -> Option<String> {
    if text.lines().any(|l| l.trim_end() == line) && text.lines().filter(|l| is_marked(l)).count() == 1 {
        return None;
    }
    let mut out = without_lines(text).unwrap_or_else(|| text.to_string());
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(line);
    out.push('\n');
    Some(out)
}

/// The text without the app's lines, or None when it has none. Everything
/// else stays byte for byte.
#[cfg_attr(windows, allow(dead_code))]
pub fn without_lines(text: &str) -> Option<String> {
    if !text.lines().any(is_marked) {
        return None;
    }
    Some(text.split_inclusive('\n').filter(|l| !is_marked(l.trim_end_matches(['\n', '\r']))).collect())
}

/// Replace a file's text in one step, through a symlink (dotfiles kept in a
/// repository stay links) and with the mode it had.
#[cfg_attr(windows, allow(dead_code))]
fn write_text(file: &Path, text: &str) -> io::Result<()> {
    let real = fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    let dir = real.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = dir.join(format!(".{name}.conclave-tmp"));
    fs::write(&tmp, text)?;
    if let Ok(meta) = fs::metadata(&real) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    fs::rename(&tmp, &real).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// Add `line` to `file` (made when missing). True when the file changed.
#[cfg_attr(windows, allow(dead_code))]
pub fn add_line(file: &Path, line: &str) -> io::Result<bool> {
    let text = match fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    match with_line(&text, line) {
        Some(next) => write_text(file, &next).map(|_| true),
        None => Ok(false),
    }
}

/// Take the app's lines out of `file`. `own_file`: the app made the whole
/// file (fish's conf.d/conclave.fish), so it goes once nothing else is in it.
/// True when something changed.
#[cfg_attr(windows, allow(dead_code))]
pub fn remove_lines(file: &Path, own_file: bool) -> io::Result<bool> {
    let text = match fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let Some(next) = without_lines(&text) else { return Ok(false) };
    if own_file && next.trim().is_empty() {
        fs::remove_file(file)?;
    } else {
        write_text(file, &next)?;
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// The link (Linux and macOS) and the copy (Windows)
// ---------------------------------------------------------------------------

/// Point `stable` at `exe`: a new symlink renamed over the old one, so the
/// command is never missing. True when it changed.
#[cfg(unix)]
pub fn point(stable: &Path, exe: &Path) -> io::Result<bool> {
    if fs::read_link(stable).ok().as_deref() == Some(exe) {
        return Ok(false);
    }
    let dir = stable.parent().ok_or_else(|| io::Error::other("no folder"))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(".conclave.new");
    let _ = fs::remove_file(&tmp);
    std::os::unix::fs::symlink(exe, &tmp)?;
    fs::rename(&tmp, stable)?;
    Ok(true)
}

/// The link at `link` to `stable`.
#[cfg(unix)]
pub fn make_link(link: &Path, stable: &Path) -> io::Result<()> {
    if let Some(dir) = link.parent() {
        fs::create_dir_all(dir)?;
    }
    std::os::unix::fs::symlink(stable, link)
}

/// A field of the note (`source=`, `path=`).
#[cfg_attr(not(windows), allow(dead_code))]
fn note_field(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| l.strip_prefix(key)?.strip_prefix('=').map(str::to_string))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn note_text(source: &Path, path_added: bool) -> String {
    format!("{NOTE_HEAD}\nsource={}\n{}", source.display(), if path_added { "path=added\n" } else { "" })
}

/// The app put the folder on the user's PATH (Windows), by its note.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn note_says_path(note: &Path) -> bool {
    fs::read_to_string(note).ok().and_then(|t| note_field(&t, "path")).as_deref() == Some("added")
}

/// Windows: `exe` at `dest`, a hard link when it can (no second 90 MB), else
/// a copy, with the note next to it naming its source. A copy that runs is
/// moved aside first: Windows cannot replace it, but it can rename it. True
/// when it changed.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn place(dest: &Path, note: &Path, exe: &Path) -> io::Result<bool> {
    let aside = dest.with_extension("exe.old");
    let _ = fs::remove_file(&aside);
    let text = fs::read_to_string(note).unwrap_or_default();
    let path_added = note_field(&text, "path").as_deref() == Some("added");
    if dest.is_file() && note_field(&text, "source").as_deref() == Some(&*exe.to_string_lossy()) {
        return Ok(false);
    }
    let dir = dest.parent().ok_or_else(|| io::Error::other("no folder"))?;
    fs::create_dir_all(dir)?;
    let next = dest.with_extension("exe.new");
    let _ = fs::remove_file(&next);
    if fs::hard_link(exe, &next).is_err() {
        fs::copy(exe, &next)?;
    }
    if dest.exists() && fs::remove_file(dest).is_err() {
        fs::rename(dest, &aside)?;
    }
    fs::rename(&next, dest)?;
    fs::write(note, note_text(exe, path_added))?;
    Ok(true)
}

/// Windows: say in the note that the app put the folder on the PATH.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn note_path_added(note: &Path) -> io::Result<()> {
    let text = fs::read_to_string(note)?;
    if note_field(&text, "path").as_deref() == Some("added") {
        return Ok(());
    }
    fs::write(note, format!("{}path=added\n", if text.ends_with('\n') { text } else { format!("{text}\n") }))
}

/// Windows: remove the app's copy and its note (a copy that runs is moved
/// aside and goes next time), then the folders when they are empty. Nothing
/// without the note. Returns whether the note said the app added the PATH entry.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn remove_copy(dest: &Path, note: &Path) -> io::Result<bool> {
    if !note.is_file() {
        return Ok(false);
    }
    let path_added = note_says_path(note);
    if dest.exists() && fs::remove_file(dest).is_err() {
        fs::rename(dest, dest.with_extension("exe.old"))?;
    }
    let _ = fs::remove_file(dest.with_extension("exe.old"));
    let _ = fs::remove_file(dest.with_extension("exe.new"));
    fs::remove_file(note)?;
    if let Some(dir) = dest.parent() {
        if fs::remove_dir(dir).is_ok() {
            // %LOCALAPPDATA%\Conclave, when nothing else is in it
            if let Some(parent) = dir.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
    Ok(path_added)
}

// ---------------------------------------------------------------------------
// Windows PATH strings (HKCU\Environment\Path, winpath.rs stores them)
// ---------------------------------------------------------------------------

/// %NAME% replaced by `var(NAME)`; unknown names stay as written.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn win_expand(s: &str, var: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => match var(&after[..end]) {
                Some(value) => {
                    out.push_str(&value);
                    rest = &after[end + 1..];
                }
                None => {
                    out.push('%');
                    rest = after;
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// One PATH entry for comparing: no quotes, variables expanded, \ for /, no
/// trailing \, and any case (Windows paths are not case sensitive).
#[cfg_attr(not(windows), allow(dead_code))]
fn win_norm(entry: &str, var: &dyn Fn(&str) -> Option<String>) -> String {
    win_expand(entry.trim().trim_matches('"'), var).replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn win_path_has(path: &str, dir: &str, var: &dyn Fn(&str) -> Option<String>) -> bool {
    let want = win_norm(dir, var);
    path.split(';').any(|e| !e.trim().is_empty() && win_norm(e, var) == want)
}

/// The PATH with `dir` at its end, or None when it has it already.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn win_path_with(path: &str, dir: &str, var: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    if win_path_has(path, dir, var) {
        return None;
    }
    let base = path.trim_end_matches(';');
    Some(if base.trim().is_empty() { dir.to_string() } else { format!("{base};{dir}") })
}

/// The PATH without `dir`, or None when it is not there. The other entries stay as written.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn win_path_without(path: &str, dir: &str, var: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    if !win_path_has(path, dir, var) {
        return None;
    }
    let want = win_norm(dir, var);
    let kept: Vec<&str> = path.split(';').filter(|e| e.trim().is_empty() || win_norm(e, var) != want).collect();
    Some(kept.join(";").trim_end_matches(';').to_string())
}

// ---------------------------------------------------------------------------
// The login (client.json)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Login {
    /// The app uses no hub yet.
    NoHub,
    /// The app's own login for this hub is there.
    Keep,
    /// Write one: none there, or the app's own names another hub.
    Write,
    /// A login the app did not write (`conclave login`): it stays. Its hub.
    Yours(String),
    /// The app wrote one before and it is gone (`conclave logout`).
    LoggedOut,
    /// No login, and the CLI has a hub of its own (~/.conclave/config.json).
    OwnHub,
}

fn same_hub(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches('/') == b.trim().trim_end_matches('/')
}

/// The login to have. `file`: client.json (Null when it is not JSON);
/// `hub`: the hub the app uses; `made_before`: the app wrote a login once;
/// `own_hub`: the CLI's home has its own config.json; `forced`: Reinstall.
pub fn login_plan(file: Option<&Value>, hub: Option<&str>, made_before: bool, own_hub: bool, forced: bool) -> Login {
    let Some(hub) = hub else { return Login::NoHub };
    match file {
        Some(v) if is_managed(v) => {
            let named = v.get("hub").and_then(Value::as_str).unwrap_or("");
            if same_hub(named, hub) {
                Login::Keep
            } else {
                Login::Write
            }
        }
        Some(v) => Login::Yours(v.get("hub").and_then(Value::as_str).unwrap_or("").to_string()),
        None if forced => Login::Write,
        None if made_before => Login::LoggedOut,
        None if own_hub => Login::OwnHub,
        None => Login::Write,
    }
}

pub fn is_managed(v: &Value) -> bool {
    v.get("managedBy").and_then(Value::as_str) == Some(MANAGED_BY)
}

/// client.json for `hub` from the hub's pairing reply, in the shape
/// `conclave login` writes (packages/cli/src/files.ts, ClientFile), with the mark.
pub fn client_file(hub: &str, reply: &Value, name: &str, saved_at_ms: u64) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("hub".into(), Value::from(hub.trim_end_matches('/')));
    m.insert("token".into(), reply.get("token").cloned().unwrap_or(Value::Null));
    if let Some(id) = reply.get("clientId").filter(|v| v.is_string()) {
        m.insert("clientId".into(), id.clone());
    }
    m.insert("name".into(), Value::from(name));
    m.insert("savedAt".into(), Value::from(saved_at_ms));
    if let Some(list) = reply.get("addresses").and_then(Value::as_array).filter(|a| !a.is_empty()) {
        m.insert("addresses".into(), Value::Array(list.clone()));
    }
    // the hub's key: the CLI sends the token only to a hub that proves it
    if let Some(id) = reply.get("identity") {
        for (from, to) in [("publicKey", "hubKey"), ("fingerprint", "fingerprint")] {
            if let Some(v) = id.get(from).filter(|v| v.is_string()) {
                m.insert(to.into(), v.clone());
            }
        }
    }
    if let Some(account) = reply.get("account").filter(|v| v.is_object()) {
        m.insert("account".into(), account.clone());
    }
    m.insert("managedBy".into(), Value::from(MANAGED_BY));
    Value::Object(m)
}

/// A JSON file: None when missing, Null when it is not JSON.
pub fn read_json(file: &Path) -> Option<Value> {
    let text = fs::read_to_string(file).ok()?;
    Some(serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// Write a file only this user can read, in one step (as the CLI writes its own, 0600).
pub fn write_private(file: &Path, value: &Value) -> io::Result<()> {
    let dir = file.parent().ok_or_else(|| io::Error::other("no folder"))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(".client.json.conclave-tmp");
    let _ = fs::remove_file(&tmp);
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let text = serde_json::to_string_pretty(value).map_err(io::Error::other)? + "\n";
    let written = opts.open(&tmp).and_then(|mut f| io::Write::write_all(&mut f, text.as_bytes())).and_then(|_| fs::rename(&tmp, file));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written
}

/// The name the hub lists the terminal under, as `conclave login` names it.
pub fn client_name() -> String {
    format!("{} (terminal)", host_name())
}

fn host_name() -> String {
    let env = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok().filter(|h| !h.trim().is_empty());
    if let Some(h) = env {
        return h.trim().to_string();
    }
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer and its length are valid; gethostname writes at most that much.
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0 {
            let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
            if !name.is_empty() {
                return name;
            }
        }
    }
    "This computer".into()
}

/// The platform as the CLI names it (node's os.platform()).
pub fn cli_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The app's command is in place. `fresh`: made in this run of the app.
    /// `added_to`: the startup file that got the PATH line in this run.
    /// `no_path`: its folder is not on the PATH and the app could not add it.
    Installed { fresh: bool, added_to: Option<String>, no_path: bool },
    Script,
    Foreign(String),
    Removed,
    /// Not there and not removed (deleted by hand): Reinstall puts it back.
    Missing,
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginState {
    Same,
    Yours(String),
    LoggedOut,
    OwnHub,
    Failed(String),
}

/// What the app is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Busy {
    Getting { done: u64, total: Option<u64> },
    Setting,
    Removing,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// installed, script, foreign, removed, missing, failed, busy, checking
    pub state: &'static str,
    pub busy: bool,
    /// One or two sentences; `conclave` and paths in backticks.
    pub words: String,
    /// One more line, such as "Open a new terminal window to use it."
    pub hint: Option<String>,
    pub can_remove: bool,
    pub can_install: bool,
}

fn mb(bytes: u64) -> String {
    let v = bytes as f64 / 1_000_000.0;
    if v < 10.0 {
        format!("{v:.1}")
    } else {
        format!("{v:.0}")
    }
}

fn full_stop(s: &str) -> String {
    let t = s.trim();
    if t.ends_with(['.', '!', '?']) {
        t.to_string()
    } else {
        format!("{t}.")
    }
}

/// The state for the Settings row. `link`: where the command goes, as shown;
/// `bin`: its folder, as shown.
pub fn view(busy: Option<Busy>, outcome: Option<&Outcome>, login: Option<&LoginState>, link: &str, bin: &str) -> View {
    if let Some(b) = busy {
        let words = match b {
            Busy::Getting { done, total: Some(t) } if t > 0 => format!("Downloading the terminal app: {} of {} MB.", mb(done), mb(t)),
            Busy::Getting { done, .. } if done > 0 => format!("Downloading the terminal app: {} MB.", mb(done)),
            Busy::Getting { .. } => "Downloading the terminal app.".into(),
            Busy::Setting => "Setting up `conclave`.".into(),
            Busy::Removing => "Removing `conclave`.".into(),
        };
        return View { state: "busy", busy: true, words, ..Default::default() };
    }
    let Some(outcome) = outcome else {
        return View { state: "checking", busy: true, words: "Checking.".into(), ..Default::default() };
    };
    let login_words = match login {
        Some(LoginState::Same) => Some("It signs in to the same hub as this app.".to_string()),
        Some(LoginState::Yours(hub)) if !hub.is_empty() => Some(format!("It keeps your own login to {hub}.")),
        Some(LoginState::Yours(_)) => Some("It keeps your own login.".into()),
        Some(LoginState::LoggedOut) => Some("It is logged out. Reinstall signs it in to this app's hub.".into()),
        Some(LoginState::OwnHub) => Some("It uses your own hub in `~/.conclave`.".into()),
        Some(LoginState::Failed(e)) => Some(format!("It cannot sign in to this app's hub yet: {}", full_stop(e))),
        None => None,
    };
    let with_login = |s: String| match &login_words {
        Some(l) => format!("{s} {l}"),
        None => s,
    };
    match outcome {
        Outcome::Installed { fresh, added_to, no_path } => {
            let hint = if *no_path {
                Some(format!("Add `{bin}` to your PATH to use it."))
            } else if let Some(file) = added_to.as_deref().filter(|f| !f.is_empty()) {
                Some(format!("Open a new terminal window to use it. The app added `{bin}` to your PATH in `{file}`."))
            } else if *fresh || added_to.is_some() {
                Some("Open a new terminal window to use it.".into())
            } else {
                None
            };
            View { state: "installed", words: with_login(format!("`conclave` is installed at `{link}`.")), hint, can_remove: true, can_install: true, ..Default::default() }
        }
        Outcome::Script => View {
            state: "script",
            words: with_login(format!("`conclave` from the install script is at `{link}`. The app leaves it as it is.")),
            hint: Some("Run the install script again to update it.".into()),
            ..Default::default()
        },
        Outcome::Foreign(at) => View { state: "foreign", words: with_login(format!("Another `conclave` is on your PATH at `{at}`, so the app leaves it as it is.")), ..Default::default() },
        Outcome::Removed => View { state: "removed", words: format!("Removed. Install puts `conclave` at `{link}` again."), can_install: true, ..Default::default() },
        Outcome::Missing => View { state: "missing", words: format!("Not installed. Install puts `conclave` at `{link}`."), can_install: true, ..Default::default() },
        Outcome::Failed(e) => View { state: "failed", words: format!("Cannot set up `conclave`: {}", full_stop(e)), can_install: true, ..Default::default() },
    }
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

/// What the manager needs from the app.
pub trait Host: Send + Sync {
    fn saved(&self) -> Saved;
    fn save(&self, saved: Saved);
    /// The app's version.
    fn version(&self) -> String;
    /// The hub the app uses, and its token.
    fn hub(&self) -> Option<(Url, String)>;
    /// The CLI of the app's version, downloaded when it is not here yet, and
    /// its version (None: a binary that CONCLAVE_HUB_BIN names).
    fn binary(&self, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<(PathBuf, Option<String>), String>;
    /// Remove the other versions, unless the hub on this computer runs.
    fn prune(&self, keep: &str);
    /// The PATH a new terminal window gets (Linux and macOS), None when the shell does not say.
    #[cfg_attr(windows, allow(dead_code))]
    fn terminal_path(&self) -> Option<String>;
    /// A client token for the terminal: the hub's pairing reply.
    fn mint(&self, base: &Url, token: &str) -> Result<Value, String>;
    /// Whether `token` still works on the hub (Ok(false): signed out there).
    fn token_works(&self, base: &Url, token: &str) -> Result<bool, String>;
    fn revoke(&self, base: &Url, token: &str, client: &str);
}

/// Where and how, fixed for a run of the app.
#[derive(Debug, Clone)]
#[cfg_attr(windows, allow(dead_code))]
pub struct Setup {
    pub paths: Paths,
    pub shell: Shell,
    pub macos: bool,
    /// $ZDOTDIR
    pub zdotdir: Option<PathBuf>,
    /// $XDG_CONFIG_HOME
    pub config_home: Option<PathBuf>,
}

#[derive(Default)]
struct Inner {
    busy: Option<Busy>,
    outcome: Option<Outcome>,
    login: Option<LoginState>,
}

/// The terminal command: one sync or removal at a time.
#[derive(Clone, Default)]
pub struct Terminal {
    inner: Arc<Mutex<Inner>>,
    work: Arc<Mutex<()>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn err(what: &str, path: &Path, e: io::Error) -> String {
    format!("{what} {}: {e}", path.display())
}

impl Terminal {
    pub fn view(&self, paths: &Paths) -> View {
        let g = self.inner.lock().unwrap();
        view(g.busy, g.outcome.as_ref(), g.login.as_ref(), &paths.link_shown(), &paths.bin_shown)
    }

    fn busy(&self, busy: Option<Busy>) {
        self.inner.lock().unwrap().busy = busy;
    }

    /// A sync is on its way: the page shows it busy at once.
    pub fn queued(&self) {
        self.busy(Some(Busy::Setting));
    }

    /// Set the command up as the plan says. `forced`: Reinstall. On the
    /// first start and after an update (another version than the saved one)
    /// it makes the link and the PATH line; on other starts it only follows
    /// the version and the login, and says what is there.
    pub fn sync(&self, host: &dyn Host, setup: &Setup, forced: bool) {
        let _one = self.work.lock().unwrap_or_else(|e| e.into_inner());
        self.busy(Some(Busy::Setting));
        let mut saved = host.saved();
        if forced {
            saved.removed = false;
        }
        let version = host.version();
        let act = forced || saved.version.as_deref() != Some(version.as_str());
        let outcome = self.place(host, setup, &saved, act, forced);
        let login = match outcome {
            Outcome::Removed => None,
            _ => self.login(host, setup, &mut saved, forced),
        };
        if act && !matches!(outcome, Outcome::Failed(_) | Outcome::Removed) {
            saved.version = Some(version);
        }
        host.save(saved);
        let mut g = self.inner.lock().unwrap();
        // made in this run: the page keeps saying to open a new terminal
        let keep_fresh = matches!(g.outcome, Some(Outcome::Installed { fresh: true, .. }));
        g.outcome = Some(match outcome {
            Outcome::Installed { fresh, added_to, no_path } => Outcome::Installed { fresh: fresh || keep_fresh, added_to, no_path },
            other => other,
        });
        g.login = login;
        g.busy = None;
    }

    /// The command itself.
    fn place(&self, host: &dyn Host, setup: &Setup, saved: &Saved, act: bool, forced: bool) -> Outcome {
        let paths = &setup.paths;
        let at = at_link(paths);
        if saved.removed && !forced && at != AtLink::Ours {
            return Outcome::Removed;
        }
        let mut shell_path: Option<Option<String>> = None;
        let mut terminal_path = || shell_path.get_or_insert_with(|| self.new_terminal_path(host)).clone();
        let foreign = if at == AtLink::Missing { self.foreign(paths, terminal_path()) } else { None };
        let link = paths.link();
        let plan = plan(&at, &link, foreign.as_deref(), saved.removed, forced);
        let linking = match plan {
            Plan::Keep => false,
            Plan::Link if act => true,
            Plan::Link => return Outcome::Missing,
            Plan::Script => return Outcome::Script,
            Plan::Foreign(p) => return Outcome::Foreign(paths.shown(&p)),
            Plan::Removed => return Outcome::Removed,
        };
        let inner = self.inner.clone();
        let mut progress = |done: u64, total: Option<u64>| {
            inner.lock().unwrap().busy = Some(Busy::Getting { done, total });
        };
        let got = host.binary(&mut progress);
        self.busy(Some(Busy::Setting));
        let (exe, version) = match got {
            Ok(found) => found,
            Err(e) => return Outcome::Failed(e),
        };
        let placed = self.put(paths, &exe, linking);
        if let Err(e) = placed {
            return Outcome::Failed(e);
        }
        if let Some(v) = version {
            host.prune(&v);
        }
        if !act {
            return Outcome::Installed { fresh: false, added_to: None, no_path: false };
        }
        let (added_to, no_path) = self.put_on_path(setup, terminal_path());
        Outcome::Installed { fresh: linking || added_to.is_some(), added_to, no_path }
    }

    /// Point the command at `exe`: the stable link (and the link, `linking`), or the copy.
    fn put(&self, paths: &Paths, exe: &Path, linking: bool) -> Result<(), String> {
        #[cfg(unix)]
        {
            let stable = paths.stable();
            point(&stable, exe).map_err(|e| err("Cannot write", &stable, e))?;
            if linking {
                let link = paths.link();
                make_link(&link, &stable).map_err(|e| err("Cannot make", &link, e))?;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = linking;
            let link = paths.link();
            place(&link, &paths.note(), exe).map_err(|e| err("Cannot copy conclave.exe to", &link, e))?;
        }
        Ok(())
    }

    /// The command's folder on the PATH a new terminal gets: the startup
    /// file's line, or the user's PATH on Windows. Returns the file that got
    /// the line now, and whether the folder is still not on the PATH.
    fn put_on_path(&self, setup: &Setup, terminal_path: Option<String>) -> (Option<String>, bool) {
        let paths = &setup.paths;
        #[cfg(windows)]
        {
            let _ = (terminal_path, setup);
            // no file to name: the user's PATH itself
            return match win_put_on_path(paths) {
                Ok(true) => (Some(String::new()), false),
                Ok(false) => (None, false),
                Err(e) => {
                    eprintln!("conclave: the terminal command's PATH: {e}");
                    (None, true)
                }
            };
        }
        #[cfg(not(windows))]
        {
            let path = terminal_path.or_else(|| std::env::var("PATH").ok()).unwrap_or_default();
            if dir_on_path(&path, &paths.bin_dir, &paths.home) {
                return (None, false);
            }
            let Some(file) = rc_file(setup.shell, setup.macos, &paths.home, setup.zdotdir.as_deref(), setup.config_home.as_deref(), &|p| p.exists()) else {
                return (None, true);
            };
            match add_line(&file, &path_line(setup.shell, &paths.bin_dir, &paths.home)) {
                Ok(true) => (Some(paths.shown(&file)), false),
                // there already: the shell sets its PATH some other way after it
                Ok(false) => (None, false),
                Err(e) => {
                    eprintln!("conclave: {}: {e}", file.display());
                    (None, true)
                }
            }
        }
    }

    fn new_terminal_path(&self, host: &dyn Host) -> Option<String> {
        #[cfg(windows)]
        {
            let _ = host;
            // what a new terminal gets: the system's PATH and the user's own as stored now
            let user = winpath::read().ok().map(|(p, _)| win_expand(&p, &|n| std::env::var(n).ok()));
            let system = std::env::var("PATH").ok();
            Some([system, user].into_iter().flatten().collect::<Vec<_>>().join(";"))
        }
        #[cfg(not(windows))]
        {
            host.terminal_path()
        }
    }

    /// Another `conclave` on the PATH a new terminal gets.
    fn foreign(&self, paths: &Paths, path: Option<String>) -> Option<PathBuf> {
        let path = path.or_else(|| std::env::var("PATH").ok())?;
        let data = fs::canonicalize(&paths.data).unwrap_or_else(|_| paths.data.clone());
        let ours = |p: &Path| p == paths.stable() || fs::canonicalize(p).is_ok_and(|c| c.starts_with(&data));
        if cfg!(windows) {
            foreign_on_path(&path, ';', WIN_NAMES, &|p| p.is_file(), &|p| ours(p) || p.parent() == Some(paths.bin_dir.as_path()))
        } else {
            foreign_on_path(&path, ':', &["conclave"], &is_command, &ours)
        }
    }

    /// The login for the hub the app uses (see `login_plan`).
    fn login(&self, host: &dyn Host, setup: &Setup, saved: &mut Saved, forced: bool) -> Option<LoginState> {
        let paths = &setup.paths;
        let hub = host.hub();
        let hub_shown = hub.as_ref().map(|(base, _)| base.as_str().trim_end_matches('/').to_string());
        let file = read_json(&paths.client());
        let own_hub = paths.cli_home.join("config.json").is_file();
        let mut plan = login_plan(file.as_ref(), hub_shown.as_deref(), saved.client.is_some(), own_hub, forced);
        let (base, token) = hub?;
        if plan == Login::Keep && forced {
            // Reinstall: a login the hub signed out is made again
            let saved_token = file.as_ref().and_then(|v| v.get("token")).and_then(Value::as_str).unwrap_or("");
            if host.token_works(&base, saved_token) == Ok(false) {
                plan = Login::Write;
            }
        }
        Some(match plan {
            Login::NoHub => return None,
            Login::Keep => LoginState::Same,
            Login::Yours(hub) => LoginState::Yours(hub),
            Login::LoggedOut => LoginState::LoggedOut,
            Login::OwnHub => LoginState::OwnHub,
            Login::Write => match host.mint(&base, &token) {
                Ok(reply) => {
                    let value = client_file(base.as_str(), &reply, &client_name(), now_ms());
                    match write_private(&paths.client(), &value) {
                        Ok(()) => {
                            saved.client = Some(reply.get("clientId").and_then(Value::as_str).unwrap_or("unknown").to_string());
                            LoginState::Same
                        }
                        Err(e) => LoginState::Failed(err("Cannot write", &paths.client(), e)),
                    }
                }
                Err(e) => LoginState::Failed(e),
            },
        })
    }

    /// Remove what the app made, by its marks, and keep it off until
    /// Reinstall. A login the app wrote is signed out on the hub too.
    pub fn remove(&self, host: &dyn Host, setup: &Setup) -> Result<(), String> {
        let _one = self.work.lock().unwrap_or_else(|e| e.into_inner());
        self.busy(Some(Busy::Removing));
        let result = remove_all(host, setup);
        let mut saved = host.saved();
        saved.removed = true;
        saved.client = None;
        host.save(saved);
        let mut g = self.inner.lock().unwrap();
        g.busy = None;
        g.login = None;
        g.outcome = Some(match &result {
            Ok(()) => Outcome::Removed,
            Err(e) => Outcome::Failed(e.clone()),
        });
        result
    }
}

/// A file that runs: executable for someone (Unix), following symlinks.
fn is_command(p: &Path) -> bool {
    match fs::metadata(p) {
        #[cfg(unix)]
        Ok(m) => {
            use std::os::unix::fs::PermissionsExt;
            m.is_file() && m.permissions().mode() & 0o111 != 0
        }
        #[cfg(not(unix))]
        Ok(m) => m.is_file(),
        Err(_) => false,
    }
}

/// Everything the app made for the command, and nothing else.
fn remove_all(host: &dyn Host, setup: &Setup) -> Result<(), String> {
    let paths = &setup.paths;
    let mut errors: Vec<String> = Vec::new();
    // the login, signed out on the hub with the app's token while the app still has it
    let client = paths.client();
    if let Some(v) = read_json(&client).filter(is_managed) {
        let named = v.get("hub").and_then(Value::as_str).unwrap_or("");
        if let (Some((base, token)), Some(id)) = (host.hub(), v.get("clientId").and_then(Value::as_str)) {
            if same_hub(base.as_str(), named) {
                host.revoke(&base, &token, id);
            }
        }
        if let Err(e) = fs::remove_file(&client) {
            errors.push(err("Cannot remove", &client, e));
        }
    }
    #[cfg(unix)]
    {
        let link = paths.link();
        if at_link(paths) == AtLink::Ours {
            if let Err(e) = fs::remove_file(&link) {
                errors.push(err("Cannot remove", &link, e));
            }
        }
        let stable = paths.stable();
        if fs::symlink_metadata(&stable).is_ok() {
            if let Err(e) = fs::remove_file(&stable) {
                errors.push(err("Cannot remove", &stable, e));
            }
        }
        if let Some(dir) = stable.parent() {
            let _ = fs::remove_dir(dir);
        }
        let fish = fish_file(&paths.home, setup.config_home.as_deref());
        for file in rc_files(&paths.home, setup.zdotdir.as_deref(), setup.config_home.as_deref()) {
            if let Err(e) = remove_lines(&file, file == fish) {
                errors.push(err("Cannot change", &file, e));
            }
        }
    }
    #[cfg(windows)]
    {
        let link = paths.link();
        match remove_copy(&link, &paths.note()) {
            Ok(true) => {
                if let Err(e) = win_take_off_path(paths) {
                    errors.push(format!("Cannot change your user PATH: {e}"));
                }
            }
            Ok(false) => {}
            Err(e) => errors.push(err("Cannot remove", &link, e)),
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(" "))
    }
}

/// Windows: the folder on the user's PATH, when it is not. True when the app added it now.
#[cfg(windows)]
fn win_put_on_path(paths: &Paths) -> Result<bool, String> {
    let var = |n: &str| std::env::var(n).ok();
    let dir = paths.bin_dir.to_string_lossy().into_owned();
    let (path, expand) = winpath::read().map_err(|e| e.to_string())?;
    let Some(next) = win_path_with(&path, &dir, &var) else { return Ok(false) };
    winpath::write(&next, expand).map_err(|e| e.to_string())?;
    note_path_added(&paths.note()).map_err(|e| e.to_string())?;
    winpath::broadcast();
    Ok(true)
}

#[cfg(windows)]
fn win_take_off_path(paths: &Paths) -> Result<(), String> {
    let var = |n: &str| std::env::var(n).ok();
    let dir = paths.bin_dir.to_string_lossy().into_owned();
    let (path, expand) = winpath::read().map_err(|e| e.to_string())?;
    if let Some(next) = win_path_without(&path, &dir, &var) {
        winpath::write(&next, expand).map_err(|e| e.to_string())?;
        winpath::broadcast();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conclave-desktop-terminal-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const LINE: &str = "export PATH=\"$HOME/.local/bin:$PATH\" # added by Conclave";

    #[test]
    fn adds_the_path_line_once_and_removes_only_marked_lines() {
        let rc = "# my zshrc\nexport EDITOR=vim\n";
        let once = with_line(rc, LINE).unwrap();
        assert_eq!(once, format!("{rc}{LINE}\n"));
        // the same again: nothing to write
        assert_eq!(with_line(&once, LINE), None);
        // a file without a newline at its end, and an empty one
        assert_eq!(with_line("alias ll='ls -l'", LINE).unwrap(), format!("alias ll='ls -l'\n{LINE}\n"));
        assert_eq!(with_line("", LINE).unwrap(), format!("{LINE}\n"));
        // an older line of the app's is replaced, so there is only ever one
        let old = format!("{rc}export PATH=\"/old/bin:$PATH\" {MARK}\nexport PAGER=less\n");
        assert_eq!(with_line(&old, LINE).unwrap(), format!("{rc}export PAGER=less\n{LINE}\n"));
        // two copies of ours (edited by hand) become one
        let twice = format!("{LINE}\n{rc}{LINE}\n");
        assert_eq!(with_line(&twice, LINE).unwrap(), format!("{rc}{LINE}\n"));
        // removal keeps every other byte, CRLF too
        assert_eq!(without_lines(&once).unwrap(), rc);
        let crlf = format!("a\r\n{LINE}\r\nb\r\n");
        assert_eq!(without_lines(&crlf).unwrap(), "a\r\nb\r\n");
        assert_eq!(without_lines(rc), None);
        // a line that only mentions Conclave is not the app's
        assert_eq!(without_lines("# Conclave things\nexport X=1 # added by me\n"), None);
    }

    #[cfg(unix)]
    #[test]
    fn edits_startup_files_through_links_and_keeps_their_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("rc");
        let dotfiles = dir.join("dotfiles");
        fs::create_dir_all(&dotfiles).unwrap();
        let real = dotfiles.join("zshrc");
        fs::write(&real, "export EDITOR=vim\n").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let rc = dir.join(".zshrc");
        std::os::unix::fs::symlink(&real, &rc).unwrap();
        assert!(add_line(&rc, LINE).unwrap());
        assert!(!add_line(&rc, LINE).unwrap());
        // still a link, the line in the file it names, its mode kept
        assert!(fs::symlink_metadata(&rc).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), format!("export EDITOR=vim\n{LINE}\n"));
        assert_eq!(fs::metadata(&real).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(remove_lines(&rc, false).unwrap());
        assert!(!remove_lines(&rc, false).unwrap());
        assert_eq!(fs::read_to_string(&real).unwrap(), "export EDITOR=vim\n");
        // a missing file is made, and a missing one to clean is fine
        let profile = dir.join(".zprofile");
        assert!(add_line(&profile, LINE).unwrap());
        assert_eq!(fs::read_to_string(&profile).unwrap(), format!("{LINE}\n"));
        assert!(!remove_lines(&dir.join(".nothing"), false).unwrap());
        // fish: the app's own file goes when nothing else is in it, and stays when you added to it
        let fish = dir.join("conf.d").join("conclave.fish");
        let fish_line = path_line(Shell::Fish, Path::new("/home/kai/.local/bin"), Path::new("/home/kai"));
        assert!(add_line(&fish, &fish_line).unwrap());
        assert!(remove_lines(&fish, true).unwrap());
        assert!(!fish.exists());
        add_line(&fish, &fish_line).unwrap();
        fs::write(&fish, format!("{}set -gx EDITOR vim\n", fs::read_to_string(&fish).unwrap())).unwrap();
        remove_lines(&fish, true).unwrap();
        assert_eq!(fs::read_to_string(&fish).unwrap(), "set -gx EDITOR vim\n");
        assert!(fs::read_dir(&dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains("conclave-tmp")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn picks_the_startup_file_a_new_terminal_reads() {
        let home = Path::new("/home/kai");
        let none = |_: &Path| false;
        let rc = |shell, macos, zdot: Option<&Path>, config: Option<&Path>, exists: &dyn Fn(&Path) -> bool| rc_file(shell, macos, home, zdot, config, exists);
        assert_eq!(rc(Shell::Zsh, true, None, None, &none), Some(home.join(".zprofile")));
        assert_eq!(rc(Shell::Zsh, false, None, None, &none), Some(home.join(".zshrc")));
        assert_eq!(rc(Shell::Zsh, true, Some(Path::new("/home/kai/.config/zsh")), None, &none), Some(PathBuf::from("/home/kai/.config/zsh/.zprofile")));
        // a relative ZDOTDIR is not used
        assert_eq!(rc(Shell::Zsh, true, Some(Path::new("zsh")), None, &none), Some(home.join(".zprofile")));
        // a login bash reads the first that exists: never a new .bash_profile next to a .profile
        assert_eq!(rc(Shell::Bash, true, None, None, &none), Some(home.join(".bash_profile")));
        let has_profile = |p: &Path| p.ends_with(".profile");
        assert_eq!(rc(Shell::Bash, true, None, None, &has_profile), Some(home.join(".profile")));
        let has_both = |p: &Path| p.ends_with(".profile") || p.ends_with(".bash_login");
        assert_eq!(rc(Shell::Bash, true, None, None, &has_both), Some(home.join(".bash_login")));
        assert_eq!(rc(Shell::Bash, false, None, None, &none), Some(home.join(".bashrc")));
        assert_eq!(rc(Shell::Fish, false, None, None, &none), Some(PathBuf::from("/home/kai/.config/fish/conf.d/conclave.fish")));
        assert_eq!(rc(Shell::Fish, true, None, Some(Path::new("/xdg")), &none), Some(PathBuf::from("/xdg/fish/conf.d/conclave.fish")));
        assert_eq!(rc(Shell::Sh, false, None, None, &none), Some(home.join(".profile")));
        assert_eq!(rc(Shell::Other, true, None, None, &none), None);
        // Remove looks in each of them, once
        let all = rc_files(home, Some(home), None);
        assert_eq!(all.len(), 7);
        assert!(all.contains(&home.join(".zprofile")) && all.contains(&home.join(".bashrc")) && all.contains(&PathBuf::from("/home/kai/.config/fish/conf.d/conclave.fish")));
    }

    #[test]
    fn knows_the_shell_and_writes_its_line() {
        assert_eq!(shell_kind("/bin/zsh"), Shell::Zsh);
        assert_eq!(shell_kind("-zsh"), Shell::Zsh);
        assert_eq!(shell_kind("/opt/homebrew/bin/bash"), Shell::Bash);
        assert_eq!(shell_kind("/usr/local/bin/fish"), Shell::Fish);
        assert_eq!(shell_kind("/bin/dash"), Shell::Sh);
        assert_eq!(shell_kind("/bin/tcsh"), Shell::Other);
        assert_eq!(shell_kind(""), Shell::Other);
        let home = Path::new("/home/kai");
        let bin = home.join(".local/bin");
        assert_eq!(path_line(Shell::Zsh, &bin, home), LINE);
        assert_eq!(path_line(Shell::Fish, &bin, home), "contains -- \"$HOME/.local/bin\" $PATH; or set -gx PATH \"$HOME/.local/bin\" $PATH # added by Conclave");
        assert_eq!(path_line(Shell::Bash, Path::new("/opt/bin"), home), "export PATH=\"/opt/bin:$PATH\" # added by Conclave");
    }

    #[test]
    fn checks_the_path() {
        let home = Path::new("/Users/kai");
        let bin = home.join(".local/bin");
        assert!(dir_on_path("/usr/bin:/Users/kai/.local/bin:/bin", &bin, home));
        assert!(dir_on_path("/Users/kai/.local/bin/:/usr/bin", &bin, home));
        assert!(dir_on_path("::~/.local/bin", &bin, home));
        assert!(dir_on_path("/Users/kai//.local/bin", &bin, home));
        assert!(!dir_on_path("/usr/bin:/bin:/usr/sbin:/sbin", &bin, home));
        assert!(!dir_on_path("/Users/kai/.local", &bin, home));
        assert!(!dir_on_path("/Users/kai/.local/bin/old:$HOME/.local/bin", &bin, home));
        assert!(!dir_on_path("", &bin, home));
    }

    #[test]
    fn a_conclave_the_app_did_not_make_is_respected() {
        let stable = Path::new("/home/kai/.local/share/dev.conclave.desktop/bin/conclave");
        let link = Path::new("/home/kai/.local/bin/conclave");
        assert_eq!(classify(link, None, false, stable), AtLink::Missing);
        assert_eq!(classify(link, Some(stable), true, stable), AtLink::Ours);
        assert_eq!(classify(link, Some(Path::new("/home/kai/.local/share/conclave/conclave")), true, stable), AtLink::Script);
        // install.sh with its own CONCLAVE_INSTALL_DIR, and a relative link to it
        assert_eq!(classify(link, Some(Path::new("/opt/conclave/conclave")), true, stable), AtLink::Script);
        assert_eq!(classify(link, Some(Path::new("../share/conclave/conclave")), true, stable), AtLink::Script);
        assert_eq!(classify(link, Some(Path::new("/home/kai/src/conclave/dist/conclave")), true, stable), AtLink::Foreign);
        // a plain file (a wrapper someone wrote) is theirs
        assert_eq!(classify(link, None, true, stable), AtLink::Foreign);
        assert_eq!(classify_copy(false, false), AtLink::Missing);
        assert_eq!(classify_copy(false, true), AtLink::Missing);
        assert_eq!(classify_copy(true, true), AtLink::Ours);
        assert_eq!(classify_copy(true, false), AtLink::Foreign);

        let elsewhere = Path::new("/opt/homebrew/bin/conclave");
        assert_eq!(plan(&AtLink::Missing, link, None, false, false), Plan::Link);
        assert_eq!(plan(&AtLink::Missing, link, Some(elsewhere), false, false), Plan::Foreign(elsewhere.into()));
        // Reinstall does not go over another one either
        assert_eq!(plan(&AtLink::Missing, link, Some(elsewhere), false, true), Plan::Foreign(elsewhere.into()));
        assert_eq!(plan(&AtLink::Script, link, None, false, true), Plan::Script);
        assert_eq!(plan(&AtLink::Foreign, link, None, false, true), Plan::Foreign(link.into()));
        assert_eq!(plan(&AtLink::Ours, link, None, false, false), Plan::Keep);
        assert_eq!(plan(&AtLink::Missing, link, None, true, false), Plan::Removed);
        assert_eq!(plan(&AtLink::Missing, link, None, true, true), Plan::Link);

        // the first one on the PATH that is not the app's
        let files = ["/opt/homebrew/bin/conclave", "/home/kai/.local/bin/conclave", "/usr/local/bin/conclave"];
        let found = |p: &Path| files.iter().any(|f| Path::new(f) == p);
        let ours = |p: &Path| p == Path::new("/home/kai/.local/bin/conclave");
        assert_eq!(foreign_on_path("/home/kai/.local/bin:/usr/bin", ':', &["conclave"], &found, &ours), None);
        assert_eq!(foreign_on_path("/home/kai/.local/bin:/opt/homebrew/bin:/usr/local/bin", ':', &["conclave"], &found, &ours), Some(PathBuf::from("/opt/homebrew/bin/conclave")));
        // empty and relative entries are skipped
        assert_eq!(foreign_on_path(":.:bin:/usr/local/bin", ':', &["conclave"], &found, &ours), Some(PathBuf::from("/usr/local/bin/conclave")));
    }

    #[test]
    fn windows_path_strings() {
        let var = |n: &str| match n.to_ascii_uppercase().as_str() {
            "LOCALAPPDATA" => Some(r"C:\Users\Kai\AppData\Local".to_string()),
            "USERPROFILE" => Some(r"C:\Users\Kai".to_string()),
            _ => None,
        };
        let dir = r"C:\Users\Kai\AppData\Local\Conclave\bin";
        assert_eq!(win_expand(r"%LOCALAPPDATA%\Conclave\bin", &var), dir);
        assert_eq!(win_expand(r"%NOPE%\x;100%", &var), r"%NOPE%\x;100%");
        assert_eq!(win_expand("%%", &var), "%%");

        // there already, written another way
        for path in [
            r"C:\Windows;C:\Users\Kai\AppData\Local\Conclave\bin",
            r"c:\users\kai\appdata\local\conclave\BIN\",
            r#""C:\Users\Kai\AppData\Local\Conclave\bin";C:\Tools"#,
            r"%LOCALAPPDATA%\Conclave\bin",
            r"%localappdata%/Conclave/bin",
        ] {
            assert!(win_path_has(path, dir, &var), "{path}");
            assert_eq!(win_path_with(path, dir, &var), None, "{path}");
        }
        assert!(!win_path_has(r"C:\Users\Kai\AppData\Local\Conclave\bin\old", dir, &var));
        // added at the end, without a doubled ;
        assert_eq!(win_path_with("", dir, &var).unwrap(), dir);
        assert_eq!(win_path_with(r"%USERPROFILE%\bin", dir, &var).unwrap(), format!(r"%USERPROFILE%\bin;{dir}"));
        assert_eq!(win_path_with(r"C:\Tools;", dir, &var).unwrap(), format!(r"C:\Tools;{dir}"));
        // taken out in any spelling; the rest stays as written, with no ; left dangling at the end
        let path = format!(r"%USERPROFILE%\bin;{dir};C:\Tools;;%LOCALAPPDATA%\Conclave\bin\");
        assert_eq!(win_path_without(&path, dir, &var).unwrap(), r"%USERPROFILE%\bin;C:\Tools");
        assert_eq!(win_path_without(&format!(r"C:\A;;{dir};C:\B"), dir, &var).unwrap(), r"C:\A;;C:\B");
        assert_eq!(win_path_without(dir, dir, &var).unwrap(), "");
        assert_eq!(win_path_without(r"C:\Tools", dir, &var), None);
        // added then taken out: as it was
        let start = r"C:\Tools;%USERPROFILE%\go\bin";
        assert_eq!(win_path_without(&win_path_with(start, dir, &var).unwrap(), dir, &var).unwrap(), start);
    }

    #[test]
    fn the_copy_is_the_apps_only_with_its_note() {
        let dir = tmp("copy");
        let v1 = dir.join("hub-bin/v1/conclave.exe");
        let v2 = dir.join("hub-bin/v2/conclave.exe");
        for (f, body) in [(&v1, "one"), (&v2, "two")] {
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, body).unwrap();
        }
        let bin = dir.join("Conclave").join("bin");
        let dest = bin.join("conclave.exe");
        let note = bin.join(NOTE);
        assert!(place(&dest, &note, &v1).unwrap());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "one");
        assert!(fs::read_to_string(&note).unwrap().starts_with(NOTE_HEAD));
        assert!(!place(&dest, &note, &v1).unwrap());
        note_path_added(&note).unwrap();
        note_path_added(&note).unwrap();
        // an update: the new one, and the note still says the PATH entry is the app's
        assert!(place(&dest, &note, &v2).unwrap());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "two");
        assert!(note_says_path(&note));
        assert_eq!(fs::read_to_string(&note).unwrap().matches("path=added").count(), 1);
        assert!(remove_copy(&dest, &note).unwrap());
        assert!(!dest.exists() && !note.exists() && !bin.exists() && !dir.join("Conclave").exists());
        // the versions it came from are not touched
        assert!(v1.exists() && v2.exists());
        assert_eq!(fs::read_to_string(&v1).unwrap(), "one");
        // someone else's conclave.exe there: no note, so it stays
        fs::create_dir_all(&bin).unwrap();
        fs::write(&dest, "theirs").unwrap();
        assert!(!remove_copy(&dest, &note).unwrap());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "theirs");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn signs_in_only_where_nothing_else_is() {
        let hub = Some("http://127.0.0.1:7717/");
        let ours = serde_json::json!({ "hub": "http://127.0.0.1:7717", "token": "t", "managedBy": MANAGED_BY });
        let moved = serde_json::json!({ "hub": "https://old.example.com", "token": "t", "managedBy": MANAGED_BY });
        let yours = serde_json::json!({ "hub": "https://hub.example.com", "token": "t" });
        assert_eq!(login_plan(None, None, false, false, false), Login::NoHub);
        assert_eq!(login_plan(None, hub, false, false, false), Login::Write);
        assert_eq!(login_plan(Some(&ours), hub, true, false, false), Login::Keep);
        // the app moved to another hub: its own login follows
        assert_eq!(login_plan(Some(&moved), hub, true, false, false), Login::Write);
        // conclave login: yours, also on Reinstall
        assert_eq!(login_plan(Some(&yours), hub, false, false, true), Login::Yours("https://hub.example.com".into()));
        assert_eq!(login_plan(Some(&Value::Null), hub, false, false, true), Login::Yours(String::new()));
        // conclave logout after the app wrote one: not again, until Reinstall
        assert_eq!(login_plan(None, hub, true, false, false), Login::LoggedOut);
        assert_eq!(login_plan(None, hub, true, false, true), Login::Write);
        // the CLI runs a hub of its own
        assert_eq!(login_plan(None, hub, false, true, false), Login::OwnHub);
        assert_eq!(login_plan(None, hub, false, true, true), Login::Write);
    }

    #[test]
    fn writes_the_login_as_conclave_login_does() {
        let reply = serde_json::json!({
            "token": "tok",
            "clientId": "c1",
            "hub": { "name": "Home" },
            "addresses": ["http://127.0.0.1:7717", "https://x.trycloudflare.com"],
            "identity": { "publicKey": "pk", "fingerprint": "fp" },
            "account": { "id": "owner", "name": "kai", "role": "owner" }
        });
        let file = client_file("http://127.0.0.1:7717/", &reply, "studio (terminal)", 42);
        assert_eq!(
            file,
            serde_json::json!({
                "hub": "http://127.0.0.1:7717",
                "token": "tok",
                "clientId": "c1",
                "name": "studio (terminal)",
                "savedAt": 42,
                "addresses": ["http://127.0.0.1:7717", "https://x.trycloudflare.com"],
                "hubKey": "pk",
                "fingerprint": "fp",
                "account": { "id": "owner", "name": "kai", "role": "owner" },
                "managedBy": "conclave-desktop"
            })
        );
        // an older hub: no key, no addresses
        let old = client_file("https://hub.example.com/", &serde_json::json!({ "token": "tok", "addresses": [] }), "n", 1);
        assert_eq!(old, serde_json::json!({ "hub": "https://hub.example.com", "token": "tok", "name": "n", "savedAt": 1, "managedBy": "conclave-desktop" }));
    }

    #[test]
    fn says_what_is_there_in_plain_words() {
        let link = "~/.local/bin/conclave";
        let bin = "~/.local/bin";
        let installed = |fresh, added_to: Option<&str>, no_path| Outcome::Installed { fresh, added_to: added_to.map(str::to_string), no_path };
        let v = view(None, Some(&installed(true, Some("~/.zprofile"), false)), Some(&LoginState::Same), link, bin);
        assert_eq!(v.words, "`conclave` is installed at `~/.local/bin/conclave`. It signs in to the same hub as this app.");
        assert_eq!(v.hint.as_deref(), Some("Open a new terminal window to use it. The app added `~/.local/bin` to your PATH in `~/.zprofile`."));
        assert!(v.can_remove && v.can_install && !v.busy);
        assert_eq!(view(None, Some(&installed(true, None, false)), None, link, bin).hint.as_deref(), Some("Open a new terminal window to use it."));
        // Windows: the user's PATH, no file to name
        assert_eq!(view(None, Some(&installed(false, Some(""), false)), None, link, bin).hint.as_deref(), Some("Open a new terminal window to use it."));
        assert_eq!(view(None, Some(&installed(false, None, false)), None, link, bin).hint, None);
        assert_eq!(view(None, Some(&installed(true, None, true)), None, link, bin).hint.as_deref(), Some("Add `~/.local/bin` to your PATH to use it."));
        let script = view(None, Some(&Outcome::Script), Some(&LoginState::Yours("https://hub.example.com".into())), link, bin);
        assert_eq!(script.words, "`conclave` from the install script is at `~/.local/bin/conclave`. The app leaves it as it is. It keeps your own login to https://hub.example.com.");
        assert!(!script.can_remove && !script.can_install);
        let other = view(None, Some(&Outcome::Foreign("/opt/homebrew/bin/conclave".into())), None, link, bin);
        assert_eq!(other.words, "Another `conclave` is on your PATH at `/opt/homebrew/bin/conclave`, so the app leaves it as it is.");
        assert!(!other.can_remove && !other.can_install);
        assert_eq!(view(None, Some(&Outcome::Removed), None, link, bin).words, "Removed. Install puts `conclave` at `~/.local/bin/conclave` again.");
        assert_eq!(view(None, Some(&Outcome::Failed("The download stopped".into())), None, link, bin).words, "Cannot set up `conclave`: The download stopped.");
        let getting = view(Some(Busy::Getting { done: 12_000_000, total: Some(40_216_150) }), None, None, link, bin);
        assert_eq!(getting.words, "Downloading the terminal app: 12 of 40 MB.");
        assert!(getting.busy && getting.state == "busy");
        assert!(view(None, None, None, link, bin).busy);
        // the house style: no em dashes
        for o in [installed(true, Some("~/.bashrc"), false), Outcome::Script, Outcome::Foreign("x".into()), Outcome::Removed, Outcome::Missing, Outcome::Failed("e".into())] {
            for l in [LoginState::Same, LoginState::Yours("h".into()), LoginState::LoggedOut, LoginState::OwnHub, LoginState::Failed("e".into())] {
                let v = view(None, Some(&o), Some(&l), link, bin);
                assert!(!v.words.contains('\u{2014}') && !v.hint.unwrap_or_default().contains('\u{2014}'));
            }
        }
    }

    #[test]
    fn keeps_its_state_in_settings() {
        assert!(Saved::default().is_empty());
        let s = Saved { version: Some("0.5.0".into()), removed: false, client: Some("c1".into()) };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"version":"0.5.0","client":"c1"}"#);
        assert_eq!(serde_json::from_str::<Saved>(&json).unwrap(), s);
        assert_eq!(serde_json::to_string(&Saved { removed: true, ..Default::default() }).unwrap(), r#"{"removed":true}"#);
    }

    // -----------------------------------------------------------------------
    // The whole sync and Remove, in a home folder of their own
    // -----------------------------------------------------------------------

    struct Fake {
        saved: Mutex<Saved>,
        version: Mutex<String>,
        exe: Mutex<PathBuf>,
        hub: Option<(Url, String)>,
        path: String,
        minted: Mutex<u32>,
        revoked: Mutex<Vec<String>>,
        pruned: Mutex<Vec<String>>,
    }

    impl Fake {
        fn new(exe: &Path, path: &str) -> Fake {
            Fake {
                saved: Mutex::default(),
                version: Mutex::new("0.5.0".into()),
                exe: Mutex::new(exe.to_path_buf()),
                hub: Some((Url::parse("http://127.0.0.1:7717/").unwrap(), "app-token".into())),
                path: path.into(),
                minted: Mutex::default(),
                revoked: Mutex::default(),
                pruned: Mutex::default(),
            }
        }
    }

    impl Host for Fake {
        fn saved(&self) -> Saved {
            self.saved.lock().unwrap().clone()
        }
        fn save(&self, saved: Saved) {
            *self.saved.lock().unwrap() = saved;
        }
        fn version(&self) -> String {
            self.version.lock().unwrap().clone()
        }
        fn hub(&self) -> Option<(Url, String)> {
            self.hub.clone()
        }
        fn binary(&self, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<(PathBuf, Option<String>), String> {
            progress(1, Some(2));
            Ok((self.exe.lock().unwrap().clone(), Some(self.version())))
        }
        fn prune(&self, keep: &str) {
            self.pruned.lock().unwrap().push(keep.into());
        }
        fn terminal_path(&self) -> Option<String> {
            Some(self.path.clone())
        }
        fn mint(&self, _base: &Url, token: &str) -> Result<Value, String> {
            assert_eq!(token, "app-token");
            let mut n = self.minted.lock().unwrap();
            *n += 1;
            Ok(serde_json::json!({ "token": format!("cli-{n}"), "clientId": format!("c{n}"), "identity": { "publicKey": "pk", "fingerprint": "fp" } }))
        }
        fn token_works(&self, _base: &Url, _token: &str) -> Result<bool, String> {
            Ok(true)
        }
        fn revoke(&self, _base: &Url, token: &str, client: &str) {
            assert_eq!(token, "app-token");
            self.revoked.lock().unwrap().push(client.into());
        }
    }

    #[cfg(unix)]
    fn executable(file: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, body).unwrap();
        fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    fn setup_in(dir: &Path, shell: Shell, macos: bool) -> Setup {
        let home = dir.join("home");
        fs::create_dir_all(&home).unwrap();
        Setup { paths: Paths::new(home.clone(), home.join(".local/share/dev.conclave.desktop"), None, None), shell, macos, zdotdir: None, config_home: None }
    }

    #[cfg(unix)]
    #[test]
    fn sets_up_follows_updates_and_removes_only_its_own() {
        let dir = tmp("sync");
        let s = setup_in(&dir, Shell::Zsh, true);
        let p = &s.paths;
        let v1 = p.data.join("hub-bin/v0.5.0/conclave-darwin-arm64/conclave");
        executable(&v1, "#!/bin/sh\necho 0.5.0\n");
        let zprofile = p.home.join(".zprofile");
        fs::write(&zprofile, "eval \"$(/opt/homebrew/bin/brew shellenv)\"\n").unwrap();
        let fake = Fake::new(&v1, "/usr/bin:/bin:/usr/sbin:/sbin");
        let t = Terminal::default();

        // first start: the link, the stable link, the PATH line, the login
        t.sync(&fake, &s, false);
        assert_eq!(fs::read_link(p.link()).unwrap(), p.stable());
        assert_eq!(fs::read_link(p.stable()).unwrap(), v1);
        assert_eq!(fs::read_to_string(p.link()).unwrap(), "#!/bin/sh\necho 0.5.0\n");
        assert_eq!(fs::read_to_string(&zprofile).unwrap(), format!("eval \"$(/opt/homebrew/bin/brew shellenv)\"\n{LINE}\n"));
        let login = read_json(&p.client()).unwrap();
        assert_eq!(login["hub"], "http://127.0.0.1:7717");
        assert_eq!(login["token"], "cli-1");
        assert_eq!(login["hubKey"], "pk");
        assert!(is_managed(&login));
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(p.client()).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(fake.saved(), Saved { version: Some("0.5.0".into()), removed: false, client: Some("c1".into()) });
        assert_eq!(*fake.pruned.lock().unwrap(), vec!["0.5.0".to_string()]);
        let v = t.view(p);
        assert_eq!(v.state, "installed");
        assert_eq!(v.words, "`conclave` is installed at `~/.local/bin/conclave`. It signs in to the same hub as this app.");
        assert_eq!(v.hint.as_deref(), Some("Open a new terminal window to use it. The app added `~/.local/bin` to your PATH in `~/.zprofile`."));

        // the next start: nothing changes, nothing is minted again
        let before = fs::read_to_string(&zprofile).unwrap();
        t.sync(&fake, &s, false);
        assert_eq!(fs::read_to_string(&zprofile).unwrap(), before);
        assert_eq!(*fake.minted.lock().unwrap(), 1);

        // an update: the stable link moves to the new version, ~/.local/bin stays as it is
        let v2 = p.data.join("hub-bin/v0.6.0/conclave-darwin-arm64/conclave");
        executable(&v2, "#!/bin/sh\necho 0.6.0\n");
        *fake.version.lock().unwrap() = "0.6.0".into();
        *fake.exe.lock().unwrap() = v2.clone();
        t.sync(&fake, &s, false);
        assert_eq!(fs::read_link(p.link()).unwrap(), p.stable());
        assert_eq!(fs::read_link(p.stable()).unwrap(), v2);
        assert_eq!(fs::read_to_string(&zprofile).unwrap(), before);
        assert_eq!(fake.saved().version.as_deref(), Some("0.6.0"));

        // things that are not the app's, next to its own
        let other_bin = p.home.join(".local/bin/other-tool");
        executable(&other_bin, "x");
        fs::write(p.home.join(".zshrc"), "alias ll='ls -l'\n").unwrap();

        // Remove: only what carries the app's mark, and the login is signed out on the hub
        t.remove(&fake, &s).unwrap();
        assert!(fs::symlink_metadata(p.link()).is_err());
        assert!(fs::symlink_metadata(p.stable()).is_err());
        assert!(!p.client().exists());
        assert_eq!(fs::read_to_string(&zprofile).unwrap(), "eval \"$(/opt/homebrew/bin/brew shellenv)\"\n");
        assert_eq!(fs::read_to_string(p.home.join(".zshrc")).unwrap(), "alias ll='ls -l'\n");
        assert!(other_bin.exists() && v1.exists() && v2.exists());
        assert_eq!(*fake.revoked.lock().unwrap(), vec!["c1".to_string()]);
        assert!(fake.saved().removed);
        assert_eq!(t.view(p).state, "removed");

        // the next start and the next update keep it removed
        t.sync(&fake, &s, false);
        *fake.version.lock().unwrap() = "0.7.0".into();
        t.sync(&fake, &s, false);
        assert!(fs::symlink_metadata(p.link()).is_err());
        assert!(!p.client().exists());
        assert_eq!(t.view(p).state, "removed");

        // Install: back again, with a new login
        t.sync(&fake, &s, true);
        assert_eq!(fs::read_link(p.link()).unwrap(), p.stable());
        assert_eq!(read_json(&p.client()).unwrap()["token"], "cli-2");
        assert!(!fake.saved().removed);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn leaves_install_sh_and_other_commands_and_logins_alone() {
        let dir = tmp("foreign");
        let s = setup_in(&dir, Shell::Bash, false);
        let p = &s.paths;
        let exe = p.data.join("hub-bin/v0.5.0/conclave-linux-x64/conclave");
        executable(&exe, "app");

        // install.sh's link at the same place
        let script = p.home.join(".local/share/conclave/conclave");
        executable(&script, "script");
        fs::create_dir_all(&p.bin_dir).unwrap();
        std::os::unix::fs::symlink(&script, p.link()).unwrap();
        // and a login of your own
        fs::create_dir_all(&p.cli_home).unwrap();
        let mine = "{\n  \"hub\": \"https://hub.example.com\",\n  \"token\": \"mine\"\n}\n";
        fs::write(p.client(), mine).unwrap();
        let fake = Fake::new(&exe, &format!("{}:/usr/bin", p.bin_dir.display()));
        let t = Terminal::default();
        t.sync(&fake, &s, false);
        assert_eq!(fs::read_link(p.link()).unwrap(), script);
        assert_eq!(fs::read_to_string(p.client()).unwrap(), mine);
        assert!(!p.home.join(".bashrc").exists());
        let v = t.view(p);
        assert_eq!(v.state, "script");
        assert_eq!(v.words, "`conclave` from the install script is at `~/.local/bin/conclave`. The app leaves it as it is. It keeps your own login to https://hub.example.com.");
        // Remove leaves them too
        t.remove(&fake, &s).unwrap();
        assert_eq!(fs::read_link(p.link()).unwrap(), script);
        assert_eq!(fs::read_to_string(p.client()).unwrap(), mine);
        assert!(fake.revoked.lock().unwrap().is_empty());
        fs::remove_file(p.link()).unwrap();

        // another conclave elsewhere on the PATH: no link, even on Reinstall
        let other = dir.join("tools/bin/conclave");
        executable(&other, "other");
        let fake = Fake::new(&exe, &format!("{}:{}", other.parent().unwrap().display(), p.bin_dir.display()));
        let t = Terminal::default();
        t.sync(&fake, &s, true);
        assert!(fs::symlink_metadata(p.link()).is_err());
        assert_eq!(t.view(p).words, format!("Another `conclave` is on your PATH at `{}`, so the app leaves it as it is. It keeps your own login to https://hub.example.com.", other.display()));
        // a file there that is not a command, or the app's own stable link on the PATH, does not count
        fs::remove_file(&other).unwrap();
        fs::write(&other, "not a command").unwrap();
        point(&p.stable(), &exe).unwrap();
        let fake = Fake::new(&exe, &format!("{}:{}:{}", other.parent().unwrap().display(), p.data.join("bin").display(), p.bin_dir.display()));
        let t = Terminal::default();
        fs::remove_file(p.client()).unwrap();
        // the CLI has a hub of its own: no login written for it
        fs::write(p.cli_home.join("config.json"), "{}").unwrap();
        t.sync(&fake, &s, false);
        assert_eq!(fs::read_link(p.link()).unwrap(), p.stable());
        // Linux bash: ~/.local/bin is on this PATH already, so .bashrc is left alone
        assert!(!p.home.join(".bashrc").exists());
        assert!(!p.client().exists());
        assert_eq!(t.view(p).words, "`conclave` is installed at `~/.local/bin/conclave`. It uses your own hub in `~/.conclave`.");
        assert_eq!(t.view(p).hint.as_deref(), Some("Open a new terminal window to use it."));
        let _ = fs::remove_dir_all(&dir);
    }
}
