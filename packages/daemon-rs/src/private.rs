//! The hub's private folder (machine/private.ts): <CONCLAVE_HOME>/cliproxy
//! holds CLIProxyAPI's config and every signed in account's tokens. A daemon
//! on the hub's own computer shares that home, so file tools, searches and
//! shell commands that name it are refused, as LocalMachine refuses them. A
//! guard against a model reading it by accident, not a wall.

use crate::errors::WireError;
use crate::paths::{native, SEP};

pub const REFUSAL: &str = "Refused: that folder holds the hub's subscription sign-ins (CLIProxyAPI). Sessions cannot read or change it. Settings > Models > Subscriptions shows the accounts.";

#[cfg(test)]
thread_local! {
    /// CONCLAVE_HOME for the test on this thread, so tests never change the process environment.
    pub static TEST_HOME: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

fn home() -> String {
    #[cfg(test)]
    if let Some(h) = TEST_HOME.with(|h| h.borrow().clone()) {
        return clean(&h);
    }
    clean(&crate::config::conclave_home().to_string_lossy())
}

fn clean(p: &str) -> String {
    let n = native::normalize(&native::resolve(&[p]));
    match n.strip_suffix(SEP) {
        Some(s) if n.len() > 1 => s.to_string(),
        _ => n,
    }
}

/// The hub's private folders: <home>/cliproxy.
pub fn dirs() -> Vec<String> {
    vec![clean(&native::join(&[&home(), "cliproxy"]))]
}

/// True when p is d or inside it.
pub fn under(p: &str, d: &str) -> bool {
    p == d || p.strip_prefix(d).is_some_and(|rest| rest.starts_with(SEP))
}

/// The real path of p, or of its nearest existing parent with the rest added back.
fn real(p: &str) -> String {
    let mut cur = p.to_string();
    let mut rest: Vec<String> = Vec::new();
    for _ in 0..64 {
        if let Ok(r) = std::fs::canonicalize(&cur) {
            let r = r.to_string_lossy().into_owned();
            let parts: Vec<&str> = std::iter::once(r.as_str()).chain(rest.iter().rev().map(String::as_str)).collect();
            return native::join(&parts);
        }
        let up = native::dirname(&cur);
        if up == cur {
            return p.to_string();
        }
        rest.push(cur[up.len() + usize::from(!up.ends_with(SEP))..].to_string());
        cur = up;
    }
    p.to_string()
}

/// True when a path is inside a private folder, following symlinks.
pub fn is_private(path: &str) -> bool {
    let dirs = dirs();
    let p = clean(path);
    if dirs.iter().any(|d| under(&p, d)) {
        return true;
    }
    let r = clean(&real(&p));
    r != p && dirs.iter().map(|d| clean(&real(d))).any(|d| under(&r, &d))
}

fn refused() -> WireError {
    WireError::coded(REFUSAL, "EACCES")
}

/// The error a file tool gets for a private path.
pub fn check(path: &str) -> Result<(), WireError> {
    if is_private(path) {
        Err(refused())
    } else {
        Ok(())
    }
}

/// remove: a recursive remove of a folder that holds a private one would take it along.
pub fn check_remove(path: &str, recursive: bool) -> Result<(), WireError> {
    check(path)?;
    let above = format!("{}{SEP}", native::resolve(&[path]));
    if recursive && dirs().iter().any(|d| d.starts_with(&above)) {
        return Err(refused());
    }
    Ok(())
}

/// True when a shell command names a private folder by its path, ~ form or CONCLAVE_HOME form.
pub fn command_touches(command: &str) -> bool {
    let home = home();
    let mut needles: Vec<String> = Vec::new();
    for d in dirs() {
        if d.len() > home.len() && under(&d, &home) {
            let tail = &d[home.len()..];
            needles.push(format!("$CONCLAVE_HOME{tail}"));
            needles.push(format!("${{CONCLAVE_HOME}}{tail}"));
        }
        needles.push(d);
    }
    needles.extend([".conclave/cliproxy", "cliproxy/auth", "cliproxy/config.yaml"].map(String::from));
    needles.iter().any(|n| command.contains(n.as_str()))
}

/// Paths outside the private folders (withoutPrivate in local.ts).
pub fn without(paths: impl IntoIterator<Item = String>) -> impl Iterator<Item = String> {
    let dirs = dirs();
    paths.into_iter().filter(move |p| !dirs.iter().any(|d| under(p, d)))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::fs;

    /// A home with a cliproxy folder, set as this thread's CONCLAVE_HOME; and a work folder with a link into it.
    pub fn fixture(name: &str) -> (String, String) {
        let root = std::env::temp_dir().join(format!("conclave-rsd-private-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (home, work) = (root.join("home"), root.join("work"));
        fs::create_dir_all(home.join("cliproxy").join("auth")).unwrap();
        fs::create_dir_all(&work).unwrap();
        fs::write(home.join("cliproxy").join("auth").join("claude-me.json"), r#"{"refresh_token":"rt-secret"}"#).unwrap();
        fs::write(home.join("cliproxy").join("config.yaml"), "access:\n  api-keys: [\"client-secret\"]\n").unwrap();
        fs::write(home.join("notes.txt"), "rt-secret is a word here too").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(home.join("cliproxy"), work.join("link")).unwrap();
        let (home, work) = (home.to_string_lossy().into_owned(), work.to_string_lossy().into_owned());
        TEST_HOME.with(|h| *h.borrow_mut() = Some(home.clone()));
        (home, work)
    }

    pub fn done(home: &str) {
        TEST_HOME.with(|h| *h.borrow_mut() = None);
        let _ = fs::remove_dir_all(std::path::Path::new(home).parent().unwrap());
    }

    #[test]
    fn paths_inside_it_also_through_a_symlink() {
        let (home, work) = fixture("paths");
        assert!(is_private(&format!("{home}/cliproxy")));
        assert!(is_private(&format!("{home}/cliproxy/auth/claude-me.json")));
        assert!(is_private(&format!("{home}/cliproxy/auth/../config.yaml")));
        #[cfg(unix)]
        assert!(is_private(&format!("{work}/link/auth/claude-me.json")));
        assert!(!is_private(&format!("{home}/cliproxy-notes")));
        assert!(!is_private(&format!("{home}/notes.txt")));
        assert_eq!(check(&format!("{home}/cliproxy/config.yaml")).unwrap_err().code.as_deref(), Some("EACCES"));
        assert!(check_remove(&home, true).is_err());
        assert!(check_remove(&home, false).is_ok());
        assert!(check_remove(&format!("{home}/notes.txt"), true).is_ok());
        let kept: Vec<String> = without([format!("{home}/notes.txt"), format!("{home}/cliproxy/config.yaml")]).collect();
        assert_eq!(kept, [format!("{home}/notes.txt")]);
        done(&home);
    }

    #[test]
    fn a_shell_command_that_names_it() {
        let (home, _) = fixture("commands");
        assert!(command_touches(&format!("cat {home}/cliproxy/auth/claude-me.json")));
        assert!(command_touches("cat ~/.conclave/cliproxy/config.yaml"));
        assert!(command_touches("cat $CONCLAVE_HOME/cliproxy/config.yaml"));
        assert!(command_touches("cat ${CONCLAVE_HOME}/cliproxy/config.yaml"));
        assert!(!command_touches("ls ~/code/cliproxy-fork"));
        done(&home);
    }

    #[test]
    fn shells_and_searches_keep_out() {
        let (home, work) = fixture("tools");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (_abort, rx) = tokio::sync::watch::channel(false);
            let exec = |command: String, cwd: &str| crate::procs::exec(command, crate::procs::ExecOpts { cwd: cwd.into(), env: None, timeout_ms: None, stdin: None, max_output: None }, rx.clone(), None);
            let r = exec(format!("cat {home}/cliproxy/config.yaml"), &work).await;
            assert_eq!((r["exitCode"].as_i64(), r["stdout"].as_str()), (Some(1), Some("")));
            assert!(r["stderr"].as_str().unwrap().contains("Refused"));
            let inside = exec("ls".into(), &format!("{home}/cliproxy")).await;
            assert!(inside["stderr"].as_str().unwrap().contains("Refused"));
            let grep = |path: String, mode: &str| {
                let mode = mode.to_string();
                crate::search::grep(crate::search::GrepOpts { pattern: "rt-secret".into(), path, glob: None, file_type: None, case_insensitive: false, multiline: false, mode, before: 0, after: 0, line_numbers: true, limit: None, offset: 0 })
            };
            let found = grep(home.clone(), "content").await.unwrap();
            let output = found["output"].as_str().unwrap();
            assert!(output.contains("notes.txt") && !output.contains("claude-me.json"), "{output}");
            assert!(grep(format!("{home}/cliproxy"), "files").await.unwrap_err().message.contains("Refused"));
            let files = crate::search::glob("**/*", crate::search::GlobOpts { cwd: home.clone(), limit: None, include_ignored: false, dot: Some(true) }).await.unwrap();
            let files: Vec<&str> = files.as_array().unwrap().iter().filter_map(|f| f.as_str()).collect();
            assert!(files.iter().any(|f| f.ends_with("notes.txt")) && !files.iter().any(|f| f.contains("/cliproxy/")), "{files:?}");
        });
        done(&home);
    }
}
