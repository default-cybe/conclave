//! The environment tools get, and finding programs on PATH.
//!
//! Shells, hooks and tools the model starts never inherit the hub's own
//! credentials (the same names and rules as isHubSecretEnv in local.ts).
//! Names in CONCLAVE_PASS_ENV (comma separated) go through anyway.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const HUB_SECRET_ENV: &[&str] = &[
    "CONCLAVE_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "OPENROUTER_API_KEY",
    "ZAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "MOONSHOT_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "DASHSCOPE_API_KEY",
    "CLIPROXY_API_KEY",
    "CLIPROXY_MANAGEMENT_KEY",
    // CLIProxyAPI turns on remote management when it sees this one
    "MANAGEMENT_PASSWORD",
];

/// isHubSecretEnv with CONCLAVE_PASS_ENV given explicitly.
pub fn is_hub_secret_env_with(name: &str, pass_env: &str) -> bool {
    if pass_env.split(',').map(crate::js::trim).filter(|s| !s.is_empty()).any(|s| s == name) {
        return false;
    }
    if HUB_SECRET_ENV.contains(&name) {
        return true;
    }
    // any other CONCLAVE_ variable that looks like a credential
    name.starts_with("CONCLAVE_") && ["TOKEN", "KEY", "SECRET", "PASSWORD"].iter().any(|w| name.contains(w))
}

#[cfg(test)]
pub fn is_hub_secret_env(name: &str) -> bool {
    is_hub_secret_env_with(name, &std::env::var("CONCLAVE_PASS_ENV").unwrap_or_default())
}

/// The daemon's environment without hub secrets, plus what the caller passed on purpose.
pub fn tool_env(extra: Option<&serde_json::Map<String, serde_json::Value>>) -> BTreeMap<OsString, OsString> {
    let pass = std::env::var("CONCLAVE_PASS_ENV").unwrap_or_default();
    let mut out = BTreeMap::new();
    for (k, v) in std::env::vars_os() {
        let keep = match k.to_str() {
            Some(name) => !is_hub_secret_env_with(name, &pass),
            None => true,
        };
        if keep {
            out.insert(k, v);
        }
    }
    if let Some(extra) = extra {
        for (k, v) in extra {
            // values a caller passes on purpose (an MCP server's env, a harness login) still go through
            let val = match v {
                serde_json::Value::String(s) => s.clone(),
                other => crate::js::js_string(Some(other)),
            };
            out.insert(OsString::from(k), OsString::from(val));
        }
    }
    out
}

/// Bun.which: the first executable called `name` on PATH (with PATHEXT on Windows).
pub fn which_in(name: &str, path_var: Option<&OsString>) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
    let has_sep = name.contains('/') || (cfg!(windows) && name.contains('\\'));
    if has_sep {
        let p = PathBuf::from(name);
        return candidates(&p).into_iter().find(|c| is_executable(c));
    }
    let path_var = path_var.cloned().or_else(|| std::env::var_os("PATH"))?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let p = dir.join(name);
        if let Some(found) = candidates(&p).into_iter().find(|c| is_executable(c)) {
            return Some(found);
        }
    }
    None
}

pub fn which(name: &str) -> Option<PathBuf> {
    which_in(name, None)
}

#[cfg(windows)]
fn candidates(p: &Path) -> Vec<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let mut out = Vec::new();
    let has_ext = p.extension().map(|e| exts.split(';').any(|x| x.trim_start_matches('.').eq_ignore_ascii_case(&e.to_string_lossy()))).unwrap_or(false);
    if has_ext {
        out.push(p.to_path_buf());
    }
    for e in exts.split(';').filter(|e| !e.is_empty()) {
        let mut s = p.as_os_str().to_os_string();
        s.push(e.to_ascii_lowercase());
        out.push(PathBuf::from(s));
    }
    out
}

#[cfg(not(windows))]
fn candidates(p: &Path) -> Vec<PathBuf> {
    vec![p.to_path_buf()]
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && m.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_names_match_local_ts() {
        let s = |n: &str| is_hub_secret_env_with(n, "");
        assert!(s("CONCLAVE_TOKEN"));
        assert!(s("ANTHROPIC_API_KEY"));
        assert!(s("CONCLAVE_GITHUB_TOKEN"));
        assert!(s("CONCLAVE_DB_PASSWORD"));
        assert!(s("CLIPROXY_API_KEY"));
        assert!(s("CLIPROXY_MANAGEMENT_KEY"));
        assert!(s("MANAGEMENT_PASSWORD"));
        assert!(!s("CONCLAVE_HOME"));
        assert!(!s("PATH"));
        assert!(!s("GITHUB_TOKEN"));
        assert!(!s("conclave_token"));
        assert!(!is_hub_secret_env("PATH"));
    }

    #[test]
    fn tool_env_drops_secrets_and_keeps_extras() {
        let mut extra = serde_json::Map::new();
        extra.insert("ANTHROPIC_API_KEY".into(), serde_json::json!("given"));
        let env = tool_env(Some(&extra));
        assert_eq!(env.get(&OsString::from("ANTHROPIC_API_KEY")), Some(&OsString::from("given")));
        assert!(!env.contains_key(&OsString::from("CONCLAVE_TOKEN")));
    }

    #[test]
    fn pass_env_lets_names_through() {
        assert!(!is_hub_secret_env_with("OPENAI_API_KEY", "OPENAI_API_KEY"));
        assert!(!is_hub_secret_env_with("OPENAI_API_KEY", " FOO , OPENAI_API_KEY ,"));
        assert!(is_hub_secret_env_with("OPENAI_API_KEY", "OPENAI_API_KEYS"));
        assert!(!is_hub_secret_env_with("CONCLAVE_X_TOKEN", "CONCLAVE_X_TOKEN"));
    }

    #[cfg(unix)]
    #[test]
    fn which_finds_sh() {
        assert!(which("sh").is_some());
        assert!(which("definitely-not-a-program-xyz").is_none());
        assert_eq!(which("/bin/sh"), Some(PathBuf::from("/bin/sh")));
    }
}
