//! The files the TypeScript daemon uses: $CONCLAVE_HOME (default ~/.conclave)
//! with device.json for the pairing. A machine paired with `conclave daemon
//! pair` runs this binary without pairing again, and the other way round.

use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn conclave_home() -> PathBuf {
    match std::env::var("CONCLAVE_HOME") {
        Ok(h) if !h.is_empty() => PathBuf::from(h),
        _ => PathBuf::from(crate::paths::home_dir()).join(".conclave"),
    }
}

pub fn device_file() -> PathBuf {
    conclave_home().join("device.json")
}

pub fn logs_dir() -> PathBuf {
    conclave_home().join("logs")
}

#[derive(Debug, Clone)]
pub struct Device {
    pub hub: String,
    pub device_id: String,
    pub token: String,
    pub name: Option<String>,
    pub addresses: Vec<String>,
    /// Every field as read, so a rewrite keeps the ones this binary does not know.
    pub raw: Map<String, Value>,
}

/// device.json when it holds a hub and a device id (readDeviceFile).
pub fn read_device() -> Option<Device> {
    read_device_at(&device_file())
}

pub fn read_device_at(path: &Path) -> Option<Device> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let raw = v.as_object()?.clone();
    let hub = raw.get("hub")?.as_str()?.to_string();
    let device_id = raw.get("deviceId")?.as_str()?.to_string();
    let token = raw.get("token").and_then(Value::as_str).unwrap_or_default().to_string();
    let name = raw.get("name").and_then(Value::as_str).map(str::to_string);
    let addresses = raw.get("addresses").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    Some(Device { hub, device_id, token, name, addresses, raw })
}

/// Write JSON readable only by this user (0600), as writePrivateJson does.
/// The file is replaced in one step, so a crash never leaves half a pairing.
pub fn write_private_json(path: &Path, data: &Value) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(data).unwrap_or_default() + "\n";
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all().ok();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// normalizeHubUrl from the CLI: add a scheme when missing, use http(s) for
/// ws(s), drop trailing slashes and a trailing /api.
pub fn normalize_hub_url(url: &str) -> String {
    let mut u = crate::js::trim(url).to_string();
    let has_scheme = {
        let b = u.as_bytes();
        let mut i = 0;
        if !b.is_empty() && b[0].is_ascii_alphabetic() {
            i = 1;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b"+.-".contains(&b[i])) {
                i += 1;
            }
        }
        i > 0 && u[i..].starts_with("://")
    };
    if !has_scheme {
        let local = ["localhost", "127.", "[::1]", "0.0.0.0"].iter().any(|p| u.starts_with(p)) || {
            // /^[^/]+:\d+/: a port before any slash
            let pre = match u.find('/') {
                Some(i) => &u[..i],
                None => u.as_str(),
            };
            let b = pre.as_bytes();
            (1..b.len()).any(|i| b[i] == b':' && b.get(i + 1).is_some_and(u8::is_ascii_digit))
        };
        u = format!("{}{u}", if local { "http://" } else { "https://" });
    }
    let lower = u.to_ascii_lowercase();
    if lower.starts_with("wss://") {
        u = format!("https://{}", &u[6..]);
    } else if lower.starts_with("ws://") {
        u = format!("http://{}", &u[5..]);
    }
    while u.ends_with('/') {
        u.pop();
    }
    if let Some(s) = u.strip_suffix("/api") {
        u = s.to_string();
    }
    u
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hub_urls_normalize_like_the_cli() {
        assert_eq!(normalize_hub_url("localhost:7717"), "http://localhost:7717");
        assert_eq!(normalize_hub_url("hub.example.com"), "https://hub.example.com");
        assert_eq!(normalize_hub_url("192.168.1.5:7717/"), "http://192.168.1.5:7717");
        assert_eq!(normalize_hub_url("wss://hub.example.com/api/"), "https://hub.example.com");
        assert_eq!(normalize_hub_url(" http://127.0.0.1:8230/// "), "http://127.0.0.1:8230");
    }

    #[test]
    fn private_json_is_0600_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("conclave-rsd-cfg-{}", std::process::id()));
        let file = dir.join("device.json");
        let data = serde_json::json!({ "hub": "http://h", "deviceId": "dev_1", "token": "t", "name": "box", "savedAt": 1, "extra": true });
        write_private_json(&file, &data).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let d = read_device_at(&file).unwrap();
        assert_eq!(d.device_id, "dev_1");
        assert_eq!(d.raw.get("extra"), Some(&Value::Bool(true)));
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("{\n  \"hub\": \"http://h\",\n  \"deviceId\""));
        std::fs::remove_dir_all(&dir).ok();
    }
}
