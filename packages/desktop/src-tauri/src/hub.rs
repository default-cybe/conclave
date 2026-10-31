//! Talking to the hub: saved settings, URL handling, and the few HTTP calls the
//! connection page needs (health check, pairing, password login, token check).

use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path, time::Duration};
use tauri::Url;

pub const DEFAULT_HUB: &str = "http://127.0.0.1:7717";

/// Saved to settings.json in the app config dir (mode 0600 on Unix).
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Normalized hub base URL, always ending in "/".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub_url: Option<String>,
    /// Client token from pairing, or a token pasted by hand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Every address the hub gave, best first (GET /api/remote). On start the
    /// app tries these when hub_url stops answering.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub addresses: Vec<String>,
    /// "Let the hub use this computer": None until the owner chose, which
    /// shows the switch on at first connect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer: Option<bool>,
    /// "Run the hub on this computer" (local.rs): the app runs the hub and uses it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub run_hub: bool,
    /// The port of the hub on this computer, once it ran (7717 unless that was taken).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hub_port: Option<u16>,
    /// The hub on this computer is one the app found running (conclave serve):
    /// the app uses it, but never starts or stops it.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hub_adopted: bool,
    /// "Let phones on this Wi-Fi connect": the hub on this computer listens on every
    /// address. Off (the default), on 127.0.0.1 only; phones then use remote access.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hub_lan: bool,
    /// The `conclave` command in a terminal (terminal.rs).
    #[serde(default, skip_serializing_if = "crate::terminal::Saved::is_empty")]
    pub terminal: crate::terminal::Saved,
    /// "Install updates automatically" (update.rs): None is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_update: Option<bool>,
}

pub(crate) fn is_false(b: &bool) -> bool {
    !*b
}

impl Settings {
    /// The saved settings, or the defaults when there are none. A file that
    /// cannot be read is logged and copied to settings.json.bad first: the
    /// next save writes over it, and the token in it may still work.
    pub fn load(path: &Path) -> Self {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("conclave: cannot read {}: {e}; starting with default settings", path.display());
                }
                return Self::default();
            }
        };
        match serde_json::from_str(&text) {
            Ok(s) => s,
            Err(e) => {
                let bad = path.with_extension("json.bad");
                let kept = match fs::copy(path, &bad) {
                    Ok(_) => format!("the old file is kept as {}", bad.display()),
                    Err(c) => format!("it could not be kept ({c})"),
                };
                eprintln!("conclave: {} is not valid settings ({e}); starting with default settings, {kept}", path.display());
                Self::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let fail = |e: std::io::Error| format!("Cannot save settings: {e}");
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(fail)?;
        }
        let data = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        // a new file renamed over the old one: a full disk or a crash never leaves the token half written
        let tmp = path.with_extension("json.tmp");
        let _ = fs::remove_file(&tmp);
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let written = opts.open(&tmp).and_then(|mut file| file.write_all(&data)).and_then(|_| fs::rename(&tmp, path));
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        written.map_err(fail)
    }
}

/// Accepts "box:7717", "http://box:7717/", "https://conclave.example.com/conclave".
/// Returns the base URL with a trailing slash so `join("api/...")` keeps any path prefix.
pub fn normalize(input: &str) -> Result<Url, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Enter the hub URL.".into());
    }
    let full = if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") };
    let mut url = Url::parse(&full).map_err(|_| format!("Not a valid URL: {raw}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("The hub URL must look like http://host:7717 or https://host.".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

/// The base URL as people type it, without the trailing slash.
pub fn display(base: &str) -> String {
    base.trim_end_matches('/').to_string()
}

/// Pairing codes are short. Anything longer is treated as a token.
pub fn looks_like_code(s: &str) -> bool {
    s.len() <= 16 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ' ')
}

/// The hub page to load. The token rides in the fragment, which is never sent over the network.
pub fn page_url(base: &Url, query: &str, token: Option<&str>) -> Url {
    let mut url = base.clone();
    url.set_query((!query.is_empty()).then_some(query));
    if let Some(token) = token {
        url.set_fragment(Some(&format!("token={}", encode(token))));
    }
    url
}

/// A page of the hub at `path` (e.g. "settings/remote"), with the token in the fragment.
pub fn page_at(base: &Url, path: &str, token: Option<&str>) -> Url {
    let mut url = base.join(path.trim_start_matches('/')).unwrap_or_else(|_| base.clone());
    if let Some(token) = token {
        url.set_fragment(Some(&format!("token={}", encode(token))));
    }
    url
}

/// Undo percent-encoding. None for a broken escape or bytes that are not UTF-8.
fn decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A quick tunnel name. Once the hub drops one, Cloudflare may give it to
/// someone else, so the app never sends its token to an old one.
fn is_quick_tunnel(url: &Url) -> bool {
    url.host_str().is_some_and(|h| h.ends_with(".trycloudflare.com"))
}

/// The hub page asked to go to another address with this app's own token in
/// the fragment: the hub moved (a quick tunnel got a new address, or the owner
/// picked another way in). Returns the new base to save. Only a page that
/// holds the token can ask this.
pub fn moved_to(current: &Url, token: Option<&str>, url: &Url) -> Option<Url> {
    let token = token?;
    if !matches!(url.scheme(), "http" | "https") || url.origin() == current.origin() {
        return None;
    }
    let given = decode(url.fragment()?.strip_prefix("token=")?)?;
    if given != token {
        return None;
    }
    normalize(url.as_str()).ok()
}

/// Saved addresses to try when `current` stops answering, in the hub's order.
/// Quick tunnel names are left out (see is_quick_tunnel).
pub fn fallbacks(current: &str, saved: &[String]) -> Vec<Url> {
    let mut out: Vec<Url> = Vec::new();
    for u in saved.iter().filter_map(|u| normalize(u).ok()) {
        if u.as_str() != current && !is_quick_tunnel(&u) && !out.contains(&u) {
            out.push(u);
        }
    }
    out
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .resolver(Ipv4First)
        .timeout_connect(Duration::from_secs(4))
        .timeout(Duration::from_secs(10))
        .build()
}

/// The host's addresses with IPv4 ones first. ureq tries one address at a
/// time, so on a Wi-Fi that hands out IPv6 but drops it (common in hotels and
/// on campus) an IPv6 address first meant waiting out the connect timeout and
/// "Cannot reach", while a browser on the same Mac falls back to IPv4 at once.
/// An IPv6 only network resolves to IPv6 addresses alone, so it still works.
pub struct Ipv4First;

impl ureq::Resolver for Ipv4First {
    fn resolve(&self, netloc: &str) -> std::io::Result<Vec<std::net::SocketAddr>> {
        use std::net::ToSocketAddrs;
        Ok(ipv4_first(netloc.to_socket_addrs()?.collect()))
    }
}

pub fn ipv4_first(mut addrs: Vec<std::net::SocketAddr>) -> Vec<std::net::SocketAddr> {
    // stable: each family keeps the resolver's order
    addrs.sort_by_key(|a| a.is_ipv6());
    addrs
}

/// A 401 or 403 from the hub. The start page (src/start.js) looks for these
/// words to show the sign-in form instead of trying again: keep them.
pub const REJECTED: &str = "The hub rejected this token or code.";

fn describe(base: &Url, err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(401 | 403, _) => REJECTED.into(),
        other => said(base, other),
    }
}

/// The hub's own words for a refusal ("Wrong name or password."), else its
/// HTTP status, or why it could not be reached.
fn said(base: &Url, err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(status, resp) => {
            let body = resp.into_string().unwrap_or_default();
            serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| format!("The hub answered HTTP {status}."))
        }
        ureq::Error::Transport(t) => format!("Cannot reach {}: {t}", display(base.as_str())),
    }
}

fn endpoint(base: &Url, path: &str) -> Result<String, String> {
    base.join(path).map(String::from).map_err(|e| e.to_string())
}

/// GET /api/health, no auth.
pub fn health(base: &Url) -> Result<(), String> {
    agent()
        .get(&endpoint(base, "api/health")?)
        .call()
        .map(|_| ())
        .map_err(|e| describe(base, e))
}

#[derive(Deserialize)]
struct HealthReply {
    /// More than one person on the hub (docs/design/ACCOUNTS.md 4). Absent from hubs before accounts.
    #[serde(default)]
    people: bool,
}

/// GET /api/health: whether the hub has more than one person, so the
/// password login asks whose password it is.
pub fn people(base: &Url) -> Result<bool, String> {
    let reply: HealthReply = agent()
        .get(&endpoint(base, "api/health")?)
        .call()
        .map_err(|e| said(base, e))?
        .into_json()
        .map_err(|e| format!("Unexpected reply from the hub: {e}"))?;
    Ok(reply.people)
}

/// GET /api/info with the token, to catch a mistyped token before saving it.
pub fn check_token(base: &Url, token: &str) -> Result<(), String> {
    agent()
        .get(&endpoint(base, "api/info")?)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map(|_| ())
        .map_err(|e| describe(base, e))
}

#[derive(Deserialize)]
struct PairReply {
    token: String,
    /// Every address of the hub, best first (hubs from before remote access send none).
    #[serde(default)]
    addresses: Vec<String>,
}

#[derive(Deserialize)]
struct RemoteReply {
    #[serde(default)]
    addresses: Vec<AddressReply>,
}

#[derive(Deserialize)]
struct AddressReply {
    url: String,
}

/// GET /api/remote: every address the hub has, best first.
pub fn addresses(base: &Url, token: &str) -> Result<Vec<String>, String> {
    let reply: RemoteReply = agent()
        .get(&endpoint(base, "api/remote")?)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| describe(base, e))?
        .into_json()
        .map_err(|e| format!("Unexpected reply from the hub: {e}"))?;
    Ok(reply.addresses.into_iter().map(|a| a.url).collect())
}

#[derive(Debug, Deserialize)]
pub struct DeviceReply {
    pub id: String,
    #[serde(default)]
    pub online: bool,
}

/// GET /api/devices: the computers paired with the hub, and which are online.
pub fn devices(base: &Url, token: &str) -> Result<Vec<DeviceReply>, String> {
    agent()
        .get(&endpoint(base, "api/devices")?)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| describe(base, e))?
        .into_json()
        .map_err(|e| format!("Unexpected reply from the hub: {e}"))
}

/// GET /api/sessions?status=<status>&limit=1: some session has that status.
pub fn has_session(base: &Url, token: &str, status: &str) -> Result<bool, String> {
    let list: Vec<serde_json::Value> = agent()
        .get(&endpoint(base, "api/sessions")?)
        .query("status", status)
        .query("limit", "1")
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| describe(base, e))?
        .into_json()
        .map_err(|e| format!("Unexpected reply from the hub: {e}"))?;
    Ok(!list.is_empty())
}

/// A pairing code for a phone, from POST /api/pairing.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub code: String,
    /// The QR code of the conclave://pair link, as SVG made by the hub.
    pub qr_svg: String,
    pub expires_at: u64,
    #[serde(default)]
    pub addresses: Vec<String>,
}

/// POST /api/pairing {kind: "client"}: a one-time code and QR for a phone.
/// With `again`, the code on screen comes back with the addresses the hub
/// has now (a tunnel came up or moved, remote access was set); a used or
/// expired one gets a new code.
pub fn create_pairing(base: &Url, token: &str, again: Option<&str>) -> Result<Pairing, String> {
    agent()
        .post(&endpoint(base, "api/pairing")?)
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(pairing_body(again))
        .map_err(|e| describe(base, e))?
        .into_json()
        .map_err(|e| format!("Unexpected reply from the hub: {e}"))
}

fn pairing_body(again: Option<&str>) -> serde_json::Value {
    match again {
        Some(code) => serde_json::json!({ "kind": "client", "code": code }),
        None => serde_json::json!({ "kind": "client" }),
    }
}

/// Where a phone can reach the hub from, by the addresses a pairing code carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reach {
    /// An https address: a tunnel, Tailscale or the owner's own URL.
    Anywhere,
    /// Only addresses on the same network.
    Network,
    /// Only this computer.
    Here,
}

pub fn reach(addresses: &[String]) -> Reach {
    let urls: Vec<Url> = addresses.iter().filter_map(|a| Url::parse(a).ok()).collect();
    let loopback = |u: &Url| match u.host_str() {
        None | Some("localhost") => true,
        Some(h) => h.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()),
    };
    if urls.iter().any(|u| u.scheme() == "https" && !loopback(u)) {
        Reach::Anywhere
    } else if urls.iter().any(|u| !loopback(u)) {
        Reach::Network
    } else {
        Reach::Here
    }
}

/// A client token of its own for the `conclave` command in a terminal
/// (terminal.rs): a pairing code made with the app's token (POST /api/pairing),
/// traded at once (POST /api/pair). The hub lists it as an app of its own,
/// which Sign out revokes. The reply as the hub sent it: token, clientId,
/// addresses, the hub's key (identity) and the account, as `conclave login` keeps them.
pub fn pair_terminal(base: &Url, app_token: &str, name: &str, platform: &str) -> Result<serde_json::Value, String> {
    let code = create_pairing(base, app_token, None)?.code;
    let reply: serde_json::Value = agent()
        .post(&endpoint(base, "api/pair")?)
        .send_json(serde_json::json!({ "code": code, "name": name, "platform": platform }))
        .map_err(|e| describe(base, e))?
        .into_json()
        .map_err(|e| format!("Unexpected pairing reply: {e}"))?;
    if reply.get("token").and_then(|t| t.as_str()).map_or(true, str::is_empty) {
        return Err("The hub's pairing reply has no token.".into());
    }
    Ok(reply)
}

/// Whether `token` still signs in (GET /api/clients, which needs one; /api/info may not).
/// Ok(false): the hub turned it away, so it was signed out there.
pub fn token_works(base: &Url, token: &str) -> Result<bool, String> {
    match agent().get(&endpoint(base, "api/clients")?).set("Authorization", &format!("Bearer {token}")).call() {
        Ok(_) => Ok(true),
        Err(ureq::Error::Status(401 | 403, _)) => Ok(false),
        Err(e) => Err(describe(base, e)),
    }
}

/// POST /api/logs/client: what the app reports about itself (perf.rs).
#[cfg(target_os = "linux")]
pub fn send_client_logs(base: &Url, token: &str, batch: &serde_json::Value) -> Result<(), String> {
    agent()
        .post(&endpoint(base, "api/logs/client")?)
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(batch)
        .map(|_| ())
        .map_err(|e| describe(base, e))
}

/// DELETE /api/clients/<id>: sign that app out of the hub.
pub fn revoke_client(base: &Url, token: &str, id: &str) -> Result<(), String> {
    let path = format!("api/clients/{}", encode(id));
    agent()
        .delete(&endpoint(base, &path)?)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map(|_| ())
        .map_err(|e| describe(base, e))
}

/// The name this app pairs and logs in as, shown in Signed in on the hub.
fn device_name() -> String {
    match std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")) {
        Ok(host) if !host.is_empty() => format!("Desktop ({host})"),
        _ => format!("Desktop ({})", std::env::consts::OS),
    }
}

/// What Settings, Signed in on the hub calls this app.
const PLATFORM: &str = "desktop";

/// POST /api/pair: trade a one-time pairing code for a client token and the hub's addresses.
pub fn pair(base: &Url, code: &str) -> Result<(String, Vec<String>), String> {
    let reply: PairReply = agent()
        .post(&endpoint(base, "api/pair")?)
        .send_json(serde_json::json!({ "code": code.trim(), "name": device_name(), "platform": PLATFORM }))
        .map_err(|e| describe(base, e))?
        .into_json()
        .map_err(|e| format!("Unexpected pairing reply: {e}"))?;
    Ok((reply.token, reply.addresses))
}

/// A password goes only over https, or to this computer or a private network
/// (docs/design/HUB-LOGIN-AND-IDENTITY.md 1): loopback, 10/8, 172.16/12,
/// 192.168/16, 100.64/10 (Tailscale), fd00::/8, *.local and *.ts.net.
pub fn password_allowed(base: &Url) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr};
    if base.scheme() == "https" {
        return true;
    }
    let Some(host) = base.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        let [a, b, ..] = ip.octets();
        return ip.is_loopback() || ip.is_private() || (a == 100 && (64..=127).contains(&b));
    }
    if let Ok(ip) = host.parse::<Ipv6Addr>() {
        return ip.is_loopback() || ip.segments()[0] & 0xff00 == 0xfd00;
    }
    host == "localhost" || [".localhost", ".local", ".ts.net"].iter().any(|end| host.ends_with(end))
}

/// The hub's key, as POST /api/pair and /api/login send it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    #[serde(default)]
    pub public_key: Option<String>,
    #[serde(default)]
    pub fingerprint: Option<String>,
}

/// Whose token it is (docs/design/ACCOUNTS.md 4).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Deserialize)]
pub struct HubName {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub fingerprint: Option<String>,
}

/// POST /api/login's reply, the same as POST /api/pair's. No Debug: it holds the token.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginReply {
    pub token: String,
    /// So a login that is not kept can be signed out again.
    #[serde(default)]
    pub client_id: Option<String>,
    /// Every address of the hub, best first.
    #[serde(default)]
    pub addresses: Vec<String>,
    /// Absent from hubs before hub identity.
    #[serde(default)]
    pub identity: Option<Identity>,
    /// Absent from hubs before accounts: the owner.
    #[serde(default)]
    pub account: Option<Account>,
    #[serde(default)]
    pub hub: Option<HubName>,
}

impl LoginReply {
    /// The hub's fingerprint in groups of four ("3f2a 9c1b ..."), as the web
    /// app shows it after a password login: the identity's, else the hub's.
    pub fn fingerprint(&self) -> Option<String> {
        let fp = self.identity.as_ref().and_then(|i| i.fingerprint.clone()).or_else(|| self.hub.as_ref().and_then(|h| h.fingerprint.clone()))?;
        let clean: Vec<char> = fp.to_ascii_lowercase().chars().filter(char::is_ascii_hexdigit).collect();
        let groups: Vec<String> = clean.chunks(4).map(|c| c.iter().collect()).collect();
        (!groups.is_empty()).then(|| groups.join(" "))
    }

    /// The name the apps show for the account (`shownName` in core/src/client/people.ts):
    /// a display name as typed, else the sign-in name with a capital; the owner's default `owner` is none.
    pub fn shown_name(&self) -> Option<String> {
        let a = self.account.as_ref()?;
        let display = a.display_name.as_deref().map(str::trim).filter(|d| !d.is_empty());
        if let Some(d) = display.filter(|d| *d != a.name) {
            return Some(d.to_string());
        }
        let n = display.unwrap_or(a.name.trim());
        if n.is_empty() || (a.role.as_deref() == Some("owner") && n.eq_ignore_ascii_case("owner")) {
            return None;
        }
        let mut chars = n.chars();
        chars.next().map(|first| first.to_uppercase().chain(chars).collect())
    }
}

fn login_body(account: Option<&str>, password: &str, name: &str) -> serde_json::Value {
    let mut body = serde_json::json!({ "password": password, "name": name, "platform": PLATFORM });
    // left out, it is the owner's password, as on a hub with one person
    if let Some(account) = account.map(str::trim).filter(|a| !a.is_empty()) {
        body["account"] = account.into();
    }
    body
}

/// POST /api/login: trade a sign-in name or email (`account`, None for the
/// owner on a hub with one person) and password for a client token, the same
/// reply as pairing. Refused before anything is sent over plain http to an
/// address that is not private. The password is never kept, logged or put in
/// an error.
pub fn login(base: &Url, account: Option<&str>, password: &str) -> Result<LoginReply, String> {
    if !password_allowed(base) {
        return Err("Use the https address of your hub to log in with a password.".into());
    }
    let reply: LoginReply = agent()
        .post(&endpoint(base, "api/login")?)
        .send_json(login_body(account, password, &device_name()))
        // a wrong name or password is the hub's own words, not "rejected this token"
        .map_err(|e| said(base, e))?
        .into_json()
        .map_err(|e| format!("Unexpected login reply: {e}"))?;
    if reply.token.is_empty() {
        return Err("The hub's login reply has no token.".into());
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipv4_addresses_come_first() {
        let a = |s: &str| s.parse::<std::net::SocketAddr>().unwrap();
        let got = ipv4_first(vec![a("[2606:4700::1]:443"), a("104.21.0.1:443"), a("[2606:4700::2]:443"), a("172.67.0.1:443")]);
        assert_eq!(got, vec![a("104.21.0.1:443"), a("172.67.0.1:443"), a("[2606:4700::1]:443"), a("[2606:4700::2]:443")]);
        assert_eq!(ipv4_first(vec![a("[::1]:1")]), vec![a("[::1]:1")]);
    }

    #[test]
    fn asks_for_the_shown_code_again() {
        assert_eq!(pairing_body(None), serde_json::json!({ "kind": "client" }));
        assert_eq!(pairing_body(Some("ABCD-EFGH")), serde_json::json!({ "kind": "client", "code": "ABCD-EFGH" }));
    }

    #[test]
    fn normalizes_hub_urls() {
        assert_eq!(normalize("box:7717").unwrap().as_str(), "http://box:7717/");
        assert_eq!(normalize(" http://127.0.0.1:7717 ").unwrap().as_str(), "http://127.0.0.1:7717/");
        assert_eq!(normalize("https://h.ts.net/conclave?x=1#y").unwrap().as_str(), "https://h.ts.net/conclave/");
        assert!(normalize("").is_err());
        assert!(normalize("ftp://box").is_err());
    }

    #[test]
    fn builds_page_urls() {
        let base = normalize("http://127.0.0.1:7717").unwrap();
        assert_eq!(page_url(&base, "", None).as_str(), "http://127.0.0.1:7717/");
        assert_eq!(page_url(&base, "quick=1", Some("a+b/c")).as_str(), "http://127.0.0.1:7717/?quick=1#token=a%2Bb%2Fc");
    }

    #[test]
    fn follows_a_hub_that_moved() {
        let old = normalize("https://old-words.trycloudflare.com").unwrap();
        let to = |u: &str| Url::parse(u).unwrap();
        // the hub page's own move: another address with this app's token
        let next = moved_to(&old, Some("a+b/c"), &to("https://new-words.trycloudflare.com/#token=a%2Bb%2Fc")).unwrap();
        assert_eq!(next.as_str(), "https://new-words.trycloudflare.com/");
        // a path prefix stays
        assert_eq!(moved_to(&old, Some("t"), &to("https://box.example.com/conclave#token=t")).unwrap().as_str(), "https://box.example.com/conclave/");
        // no token, another token, the same origin, or another scheme: not a move
        assert!(moved_to(&old, Some("t"), &to("https://elsewhere.example.com/")).is_none());
        assert!(moved_to(&old, Some("t"), &to("https://elsewhere.example.com/#token=x")).is_none());
        assert!(moved_to(&old, None, &to("https://elsewhere.example.com/#token=t")).is_none());
        assert!(moved_to(&old, Some("t"), &to("https://old-words.trycloudflare.com/s/1#token=t")).is_none());
        assert!(moved_to(&old, Some("t"), &to("file:///etc/passwd#token=t")).is_none());
    }

    #[test]
    fn falls_back_in_the_hubs_order_without_old_quick_tunnels() {
        let saved = vec![
            "https://old-words.trycloudflare.com".to_string(),
            "https://conclave.example.com".to_string(),
            "http://192.168.1.20:7717".to_string(),
            "http://192.168.1.20:7717/".to_string(),
            "not a url at all".to_string(),
        ];
        let list: Vec<String> = fallbacks("https://conclave.example.com/", &saved).into_iter().map(String::from).collect();
        // the address in use and the old quick tunnel are skipped, duplicates and junk dropped
        assert_eq!(list, vec!["http://192.168.1.20:7717/".to_string()]);
    }

    #[test]
    fn decodes_fragments() {
        assert_eq!(decode("a%2Bb%2Fc").as_deref(), Some("a+b/c"));
        assert_eq!(decode("plain").as_deref(), Some("plain"));
        assert!(decode("bad%zz").is_none());
        assert!(decode("cut%2").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn saving_replaces_the_file_in_one_step() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("conclave-desktop-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        // an older file others could read: the save puts a new private one in its place
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let s = Settings { hub_url: Some("http://box:7717/".into()), token: Some("t".into()), ..Default::default() };
        s.save(&path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(Settings::load(&path).token.as_deref(), Some("t"));
        assert!(!dir.join("settings.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_settings_file_is_kept_aside() {
        let dir = std::env::temp_dir().join(format!("conclave-desktop-broken-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        assert!(Settings::load(&path).token.is_none());
        assert!(!dir.join("settings.json.bad").exists());
        fs::write(&path, r#"{"hubUrl":"http://box:7717/","token":"t""#).unwrap();
        assert!(Settings::load(&path).token.is_none());
        assert_eq!(fs::read_to_string(dir.join("settings.json.bad")).unwrap(), r#"{"hubUrl":"http://box:7717/","token":"t""#);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn builds_page_urls_with_a_path() {
        let base = normalize("http://127.0.0.1:7717").unwrap();
        assert_eq!(page_at(&base, "settings/remote", Some("a+b")).as_str(), "http://127.0.0.1:7717/settings/remote#token=a%2Bb");
        let prefixed = normalize("https://box.example.com/conclave").unwrap();
        assert_eq!(page_at(&prefixed, "/settings/remote", None).as_str(), "https://box.example.com/conclave/settings/remote");
    }

    #[test]
    fn says_where_phones_reach_the_hub() {
        let list = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(reach(&list(&["https://quick-words.trycloudflare.com", "http://192.168.1.20:7717"])), Reach::Anywhere);
        assert_eq!(reach(&list(&["http://192.168.1.20:7717"])), Reach::Network);
        assert_eq!(reach(&list(&["http://127.0.0.1:7717", "http://[::1]:7717"])), Reach::Here);
        assert_eq!(reach(&list(&["https://localhost:7717"])), Reach::Here);
        assert_eq!(reach(&[]), Reach::Here);
    }

    #[test]
    fn keeps_the_hub_switch_in_settings() {
        let s = Settings { run_hub: true, hub_port: Some(7718), ..Default::default() };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"runHub":true,"hubPort":7718}"#);
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(back.run_hub && !back.hub_adopted && back.hub_port == Some(7718));
        // settings from before the switch
        let old: Settings = serde_json::from_str(r#"{"hubUrl":"http://box:7717/","token":"t"}"#).unwrap();
        assert!(!old.run_hub && old.hub_port.is_none());
        assert_eq!(serde_json::to_string(&Settings::default()).unwrap(), "{}");
    }

    #[test]
    fn tells_codes_from_tokens() {
        assert!(looks_like_code("ABCD-1234"));
        assert!(!looks_like_code("k3J9f0aQ2xL8pV1mN6rT4yW7zB5cD0eF"));
    }

    #[test]
    fn asks_with_the_name_only_when_there_is_one() {
        let body = login_body(Some(" sam "), "correct horse battery", "Desktop (box)");
        assert_eq!(body, serde_json::json!({ "account": "sam", "password": "correct horse battery", "name": "Desktop (box)", "platform": "desktop" }));
        // no name, or an empty one: the owner's password, as on a hub with one person
        let owner = serde_json::json!({ "password": "pw", "name": "Desktop (box)", "platform": "desktop" });
        assert_eq!(login_body(None, "pw", "Desktop (box)"), owner);
        assert_eq!(login_body(Some("  "), "pw", "Desktop (box)"), owner);
    }

    #[test]
    fn sends_a_password_only_over_https_or_a_private_network() {
        let ok = |u: &str| password_allowed(&normalize(u).unwrap());
        for u in [
            "https://hub.example.com",
            "http://127.0.0.1:7717",
            "http://localhost:7717",
            "http://192.168.1.20:7717",
            "http://10.0.0.5",
            "http://172.20.0.1",
            "http://100.101.1.2",
            "http://box.local:7717",
            "http://box.tail1234.ts.net",
            "http://[::1]:7717",
            "http://[fd12:3456::1]:7717",
        ] {
            assert!(ok(u), "{u}");
        }
        for u in ["http://hub.example.com", "http://8.8.8.8:7717", "http://172.32.0.1", "http://100.128.0.1", "http://[2001:db8::1]", "http://box:7717"] {
            assert!(!ok(u), "{u}");
        }
    }

    #[test]
    fn reads_a_login_reply() {
        let reply: LoginReply = serde_json::from_value(serde_json::json!({
            "token": "cnc_t",
            "clientId": "c1",
            "hub": { "name": "madx", "version": "0.4.2", "fingerprint": "ffffffffffffffffffffffffffffffff" },
            "addresses": ["https://madx.example.com", "http://192.168.1.20:7717"],
            "identity": { "publicKey": "julIIIdU_MQWrCl_L17QIz9HxrWRtvpDhiR4bquAYJM", "fingerprint": "3F2A9C1B00112233445566778899AABB" },
            "account": { "id": "acc_1", "name": "sam", "displayName": "Sam Lee", "role": "member" }
        }))
        .unwrap();
        assert_eq!(reply.token, "cnc_t");
        assert_eq!(reply.client_id.as_deref(), Some("c1"));
        assert_eq!(reply.addresses.len(), 2);
        assert_eq!(reply.identity.as_ref().and_then(|i| i.public_key.as_deref()), Some("julIIIdU_MQWrCl_L17QIz9HxrWRtvpDhiR4bquAYJM"));
        // the identity's fingerprint, in groups of four, as the web app shows it
        assert_eq!(reply.fingerprint().as_deref(), Some("3f2a 9c1b 0011 2233 4455 6677 8899 aabb"));
        assert_eq!(reply.shown_name().as_deref(), Some("Sam Lee"));

        // a hub before identity and accounts: only the token
        let old: LoginReply = serde_json::from_value(serde_json::json!({ "token": "t", "hub": { "name": "madx" } })).unwrap();
        assert!(old.fingerprint().is_none() && old.shown_name().is_none() && old.addresses.is_empty() && old.client_id.is_none());
        assert!(serde_json::from_value::<LoginReply>(serde_json::json!({ "error": "nope" })).is_err());

        // the names the apps show (shownName): a sign-in name gets a capital, the owner's default is none
        let named = |a: serde_json::Value| serde_json::from_value::<LoginReply>(serde_json::json!({ "token": "t", "account": a })).unwrap().shown_name();
        assert_eq!(named(serde_json::json!({ "name": "sam", "displayName": "sam", "role": "member" })).as_deref(), Some("Sam"));
        assert_eq!(named(serde_json::json!({ "name": "riley", "role": "member" })).as_deref(), Some("Riley"));
        assert_eq!(named(serde_json::json!({ "name": "owner", "role": "owner" })), None);
        assert_eq!(named(serde_json::json!({ "name": "owner", "displayName": "Kai Ahir", "role": "owner" })).as_deref(), Some("Kai Ahir"));
    }

    /// A stand-in hub for one request: answers `status` with `reply`, and hands
    /// on the request line and the JSON body it got.
    fn stand_in_hub(status: &'static str, reply: serde_json::Value) -> (Url, std::sync::mpsc::Receiver<(String, serde_json::Value)>) {
        use std::io::Read;
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = normalize(&format!("127.0.0.1:{}", listener.local_addr().unwrap().port())).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            let head_end = loop {
                let n = stream.read(&mut buf).unwrap();
                req.extend_from_slice(&buf[..n]);
                if let Some(i) = req.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
                assert!(n > 0, "the request ended early");
            };
            let head = String::from_utf8_lossy(&req[..head_end]).into_owned();
            let len: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
            while req.len() < head_end + len {
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0, "the body ended early");
                req.extend_from_slice(&buf[..n]);
            }
            let body = serde_json::from_slice(&req[head_end..head_end + len]).unwrap_or(serde_json::Value::Null);
            let text = reply.to_string();
            write!(stream, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len()).unwrap();
            tx.send((head.lines().next().unwrap_or_default().to_string(), body)).unwrap();
        });
        (base, rx)
    }

    #[test]
    fn logs_in_with_a_name_and_password() {
        let (base, got) = stand_in_hub(
            "200 OK",
            serde_json::json!({ "token": "cnc_member", "clientId": "c9", "hub": { "name": "madx" }, "identity": { "publicKey": "pk", "fingerprint": "00112233445566778899aabbccddeeff" }, "account": { "id": "acc_1", "name": "sam", "role": "member" } }),
        );
        let reply = login(&base, Some("sam"), "a password of twelve").ok().unwrap();
        assert_eq!(reply.token, "cnc_member");
        assert_eq!(reply.fingerprint().as_deref(), Some("0011 2233 4455 6677 8899 aabb ccdd eeff"));
        let (line, body) = got.recv().unwrap();
        assert_eq!(line, "POST /api/login HTTP/1.1");
        assert_eq!(body["account"], "sam");
        assert_eq!(body["password"], "a password of twelve");
        assert_eq!(body["platform"], "desktop");
        assert!(body["name"].as_str().is_some_and(|n| n.starts_with("Desktop (")));
    }

    #[test]
    fn says_the_hubs_own_words_when_it_says_no() {
        let (base, _got) = stand_in_hub("400 Bad Request", serde_json::json!({ "error": "Wrong name or password." }));
        assert_eq!(login(&base, Some("sam"), "not it").err().as_deref(), Some("Wrong name or password."));
        let (base, _got) = stand_in_hub("429 Too Many Requests", serde_json::json!({ "error": "Too many wrong pairing codes or passwords from this address. Try again in 60 seconds." }));
        assert_eq!(login(&base, None, "x").err().as_deref(), Some("Too many wrong pairing codes or passwords from this address. Try again in 60 seconds."));
        // a reply with no token is not a login
        let (base, _got) = stand_in_hub("200 OK", serde_json::json!({ "token": "" }));
        assert_eq!(login(&base, None, "x").err().as_deref(), Some("The hub's login reply has no token."));
        // nothing answers: the same words as for pairing
        let gone = {
            let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            normalize(&format!("127.0.0.1:{}", l.local_addr().unwrap().port())).unwrap()
        };
        assert!(login(&gone, None, "x").err().unwrap().starts_with(&format!("Cannot reach {}", display(gone.as_str()))));
        // plain http to the internet: refused before anything is sent
        let far = normalize("http://hub.example.com").unwrap();
        assert_eq!(login(&far, None, "x").err().as_deref(), Some("Use the https address of your hub to log in with a password."));
    }

    /// A real hub with a member: `CONCLAVE_TEST_LOGIN_HUB=http://127.0.0.1:<port> CONCLAVE_TEST_LOGIN_NAME=<name>
    /// CONCLAVE_TEST_LOGIN_PASSWORD=<password> cargo test real_login -- --ignored`. Use a throwaway hub.
    #[test]
    #[ignore]
    fn real_login() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k}"));
        let base = normalize(&var("CONCLAVE_TEST_LOGIN_HUB")).unwrap();
        let (name, password) = (var("CONCLAVE_TEST_LOGIN_NAME"), var("CONCLAVE_TEST_LOGIN_PASSWORD"));
        assert_eq!(people(&base), Ok(true));
        assert_eq!(login(&base, Some(&name), "not the password").err().as_deref(), Some("Wrong name or password."));
        assert_eq!(login(&base, None, &password).err().as_deref(), Some("Wrong name or password."));
        let reply = login(&base, Some(&name), &password).ok().unwrap();
        assert_eq!(reply.account.as_ref().map(|a| (a.name.as_str(), a.role.as_deref())), Some((name.as_str(), Some("member"))));
        assert_eq!(reply.fingerprint().map(|f| f.split(' ').count()), Some(8));
        assert_eq!(token_works(&base, &reply.token), Ok(true));
        // Not my hub: the login is signed out again
        revoke_client(&base, &reply.token, reply.client_id.as_deref().unwrap()).unwrap();
        assert_eq!(token_works(&base, &reply.token), Ok(false));
    }

    #[test]
    fn asks_the_hub_whether_it_has_people() {
        let (base, got) = stand_in_hub("200 OK", serde_json::json!({ "ok": true, "version": "0.4.2", "uptimeMs": 1, "people": true }));
        assert_eq!(people(&base), Ok(true));
        assert_eq!(got.recv().unwrap().0, "GET /api/health HTTP/1.1");
        // a hub before accounts says nothing: one person
        let (base, _got) = stand_in_hub("200 OK", serde_json::json!({ "ok": true, "version": "0.3.0" }));
        assert_eq!(people(&base), Ok(false));
    }
}
