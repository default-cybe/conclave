//! Syncthing on this device (machine/syncthing.ts): folders from config.xml,
//! one folder's state from the local REST API. The GUI API key is used for
//! that one call and never leaves the device.

use crate::errors::{Res, WireError};
use crate::paths::native::join;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub struct Folder {
    pub id: String,
    pub label: String,
    pub path: String,
    pub paused: bool,
}

pub struct Gui {
    pub address: String,
    pub tls: bool,
    pub api_key: Option<String>,
}

pub struct Parsed {
    pub folders: Vec<Folder>,
    pub gui: Option<Gui>,
}

/// Where Syncthing keeps config.xml, in the order Syncthing itself looks.
pub fn config_dirs(home: &str, env: &dyn Fn(&str) -> Option<String>) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    let mut add = |d: String| {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    };
    let get = |k: &str| env(k).filter(|v| !v.is_empty());
    if let Some(v) = get("STCONFDIR") {
        add(v);
    }
    if let Some(v) = get("STHOMEDIR") {
        add(v);
    }
    if let Some(v) = get("XDG_STATE_HOME") {
        add(join(&[&v, "syncthing"]));
    }
    add(join(&[home, ".local", "state", "syncthing"]));
    // before Syncthing 1.27
    if let Some(v) = get("XDG_CONFIG_HOME") {
        add(join(&[&v, "syncthing"]));
    }
    add(join(&[home, ".config", "syncthing"]));
    add(join(&[home, "Library", "Application Support", "Syncthing"]));
    if let Some(v) = get("LOCALAPPDATA") {
        add(join(&[&v, "Syncthing"]));
    }
    dirs
}

fn decode_xml(s: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)&(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-f]+);").unwrap());
    re.replace_all(s, |c: &regex::Captures| {
        let k = c[1].to_lowercase();
        match k.as_str() {
            "amp" => "&".into(),
            "lt" => "<".into(),
            "gt" => ">".into(),
            "quot" => "\"".into(),
            "apos" => "'".into(),
            _ => {
                let code = if let Some(h) = k.strip_prefix("#x") { u32::from_str_radix(h, 16).ok() } else { k[1..].parse::<u32>().ok() };
                code.and_then(char::from_u32).map(|ch| ch.to_string()).unwrap_or_else(|| c[0].to_string())
            }
        }
    })
    .into_owned()
}

fn attrs(tag: &str) -> Vec<(String, String)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*"([^"]*)""#).unwrap());
    let mut out: Vec<(String, String)> = Vec::new();
    for c in re.captures_iter(tag) {
        let k = c[1].to_string();
        let v = decode_xml(&c[2]);
        if let Some(e) = out.iter_mut().find(|(n, _)| *n == k) {
            e.1 = v;
        } else {
            out.push((k, v));
        }
    }
    out
}

fn attr<'a>(a: &'a [(String, String)], k: &str) -> Option<&'a str> {
    a.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
}

fn expand_home(p: &str, home: &str) -> String {
    if p == "~" {
        return home.to_string();
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        return join(&[home, rest]);
    }
    p.to_string()
}

/// parseSyncthingConfig: one forward pass; a folder ends at its </folder>, or at the next <folder>.
pub fn parse_config(xml: &str, home: &str) -> Parsed {
    static OPEN: OnceLock<Regex> = OnceLock::new();
    static PAUSED: OnceLock<Regex> = OnceLock::new();
    static GUI: OnceLock<Regex> = OnceLock::new();
    static ADDR: OnceLock<Regex> = OnceLock::new();
    static KEY: OnceLock<Regex> = OnceLock::new();
    let open = OPEN.get_or_init(|| Regex::new(r"<folder(?-u:\b)([^>]*?)(/?)>").unwrap());
    let paused_re = PAUSED.get_or_init(|| Regex::new(r"(?i)<paused>\s*(true|false)\s*</paused>").unwrap());
    let mut folders = Vec::new();
    let mut pos = 0;
    while let Some(m) = open.captures_at(xml, pos) {
        let whole = m.get(0).unwrap();
        let a = attrs(&m[1]);
        let mut body = "";
        let mut next_pos = whole.end();
        if m[2].is_empty() {
            let start = whole.end();
            let end = xml[start..].find("</folder>").map(|i| i + start);
            let next = xml[start..].find("<folder").map(|i| i + start);
            let stop = match (end, next) {
                (Some(e), n) if n.is_none() || e < n.unwrap() => e,
                (_, Some(n)) => n,
                _ => xml.len(),
            };
            body = &xml[start..stop];
            next_pos = if Some(stop) == end { stop + "</folder>".len() } else { stop };
        }
        pos = next_pos;
        let (Some(id), Some(path)) = (attr(&a, "id").filter(|s| !s.is_empty()), attr(&a, "path").filter(|s| !s.is_empty())) else { continue };
        let paused_tag = paused_re.captures(body).map(|c| c[1].to_string());
        let paused = paused_tag.as_deref().or(attr(&a, "paused")).unwrap_or("false").to_lowercase() == "true";
        let mut path = expand_home(path, home);
        if path.len() > 1 {
            while !path.is_empty() && (path.ends_with('/') || path.ends_with('\\')) {
                path.pop();
            }
        }
        let label = attr(&a, "label").filter(|s| !s.is_empty()).unwrap_or(id).to_string();
        folders.push(Folder { id: id.to_string(), label, path, paused });
    }
    let gui_re = GUI.get_or_init(|| Regex::new(r"<gui(?-u:\b)([^>]*)>((?s:.)*?)</gui>").unwrap());
    let addr_re = ADDR.get_or_init(|| Regex::new(r"<address>([^<]*)</address>").unwrap());
    let key_re = KEY.get_or_init(|| Regex::new(r"<apikey>([^<]*)</apikey>").unwrap());
    let gui = gui_re.captures(xml).and_then(|g| {
        let ga = attrs(&g[1]);
        let address = decode_xml(addr_re.captures(&g[2]).map(|c| crate::js::trim(c.get(1).unwrap().as_str()).to_string()).as_deref().unwrap_or("127.0.0.1:8384"));
        let api_key = key_re.captures(&g[2]).map(|c| crate::js::trim(c.get(1).unwrap().as_str()).to_string()).filter(|k| !k.is_empty());
        if attr(&ga, "enabled") == Some("false") {
            return None;
        }
        Some(Gui { address, tls: attr(&ga, "tls") == Some("true"), api_key: api_key.map(|k| decode_xml(&k)) })
    });
    Parsed { folders, gui }
}

fn os_env(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

fn read_config(home: &str) -> Option<Parsed> {
    for dir in config_dirs(home, &os_env) {
        if let Ok(xml) = std::fs::read_to_string(join(&[&dir, "config.xml"])) {
            return Some(parse_config(&xml, home));
        }
    }
    None
}

pub fn folders_json(home: &str) -> Value {
    let list = read_config(home).map(|p| p.folders).unwrap_or_default();
    Value::Array(list.into_iter().map(|f| json!({ "id": f.id, "label": f.label, "path": f.path, "paused": f.paused })).collect())
}

/// One folder's sync state: state, needFiles, needBytes and pullErrors only.
pub async fn status(folder_id: &str, home: &str) -> Res<Value> {
    let h = home.to_string();
    let cfg = tokio::task::spawn_blocking(move || read_config(&h)).await.ok().flatten();
    let Some(cfg) = cfg else { return Err(WireError::coded("Syncthing is not set up on this device", "ENOENT")) };
    if !cfg.folders.iter().any(|f| f.id == folder_id) {
        return Err(WireError::coded(format!("no Syncthing folder {folder_id} on this device"), "ENOENT"));
    }
    let Some(gui) = cfg.gui.filter(|g| g.api_key.is_some()) else { return Err(WireError::new("Syncthing has no GUI API key on this device")) };
    let mut address = gui.address.clone();
    for p in ["tcp4://", "tcp6://", "tcp://"] {
        if let Some(r) = address.strip_prefix(p) {
            address = r.to_string();
            break;
        }
    }
    if address.starts_with("unix") || address.starts_with('/') {
        return Err(WireError::new("Syncthing listens on a socket Conclave does not read"));
    }
    if let Some(r) = address.strip_prefix("0.0.0.0:") {
        address = format!("127.0.0.1:{r}");
    } else if let Some(r) = address.strip_prefix("[::]:") {
        address = format!("[::1]:{r}");
    }
    let url = format!("{}://{address}/rest/db/status?folder={}", if gui.tls { "https" } else { "http" }, crate::js::encode_uri_component(folder_id));
    let key = gui.api_key.unwrap_or_default();
    let res = crate::net::request("GET", &url, &[("X-API-Key", &key)], None, Duration::from_millis(3_000)).await.map_err(WireError::new)?;
    if !(200..300).contains(&res.status) {
        return Err(WireError::new(format!("Syncthing answered {}", res.status)));
    }
    let body: Value = serde_json::from_slice(&res.body).map_err(|e| WireError::new(format!("JSON Parse error: {e}")))?;
    let n = |k: &str| body.get(k).filter(|v| v.is_number()).cloned().unwrap_or(json!(0));
    Ok(json!({
        "state": body.get("state").and_then(Value::as_str).unwrap_or("unknown"),
        "needFiles": n("needFiles"),
        "needBytes": n("needBytes"),
        "pullErrors": n("pullErrors"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_folders_and_gui() {
        let xml = r#"<configuration>
  <folder id="abc-123" label="Projects" path="~/Projects/" type="sendreceive">
    <paused>false</paused>
  </folder>
  <folder id="x" path="/data/x" paused="true"/>
  <folder id="y" label="" path="/srv/y&amp;z">
    <paused> true </paused>
  </folder>
  <folder label="no id" path="/nope"></folder>
  <gui enabled="true" tls="false"><address>0.0.0.0:8384</address><apikey>KEY123</apikey></gui>
</configuration>"#;
        let p = parse_config(xml, "/home/me");
        assert_eq!(
            p.folders,
            vec![
                Folder { id: "abc-123".into(), label: "Projects".into(), path: "/home/me/Projects".into(), paused: false },
                Folder { id: "x".into(), label: "x".into(), path: "/data/x".into(), paused: true },
                Folder { id: "y".into(), label: "y".into(), path: "/srv/y&z".into(), paused: true },
            ]
        );
        let g = p.gui.unwrap();
        assert_eq!((g.address.as_str(), g.tls, g.api_key.as_deref()), ("0.0.0.0:8384", false, Some("KEY123")));
    }

    #[test]
    fn a_cut_off_file_still_parses() {
        let p = parse_config(r#"<folder id="a" path="/a"><paused>true</paused><folder id="b" path="/b">"#, "/h");
        assert_eq!(p.folders.len(), 2);
        assert!(p.folders[0].paused);
        assert!(!p.folders[1].paused);
    }

    #[test]
    fn config_dirs_order() {
        let env = |k: &str| match k {
            "XDG_STATE_HOME" => Some("/st".to_string()),
            _ => None,
        };
        let d = config_dirs("/home/me", &env);
        assert_eq!(d[0], join(&["/st", "syncthing"]));
        assert_eq!(d[1], join(&["/home/me", ".local", "state", "syncthing"]));
    }
}
