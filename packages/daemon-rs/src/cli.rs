//! The subcommands in docs/design/DAEMON-SIDECAR.md: run, pair, install,
//! uninstall, status, plus unpair, --version and --help. Exit 0 when done, 1
//! on failure and 2 on bad usage, with one "Error: <sentence>" line on stderr.

use crate::config::{self, normalize_hub_url, read_device, write_private_json};
use crate::info::VERSION;
use crate::service::{self, Plan, Step};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::time::Duration;

pub const USAGE_TAIL: &str = "Usage
  conclave-daemon [run] [--hub URL] [--log FILE]       run the daemon (what the service runs)
  conclave-daemon pair --hub URL --app-token-stdin     pair with the token of the app that is paired already
  conclave-daemon pair --hub URL --code CODE           pair with a device code from the Devices page
  conclave-daemon install [--dry-run]                  a user service that runs it at login, started now
  conclave-daemon uninstall [--keep-pairing] [--json]  stop and remove the service, and unpair
  conclave-daemon status --json                        paired, installed, running
  conclave-daemon unpair [--json]                      remove this computer from the hub, keep the service
  conclave-daemon rollback                             put back the version an update replaced, then restart the service
  conclave-daemon --version

Contract: docs/design/DAEMON-SIDECAR.md";

pub fn usage() -> String {
    format!("conclave-daemon {VERSION}: lets a Conclave hub use this computer's files, shells and coding tools.\n\n{USAGE_TAIL}")
}

/// A failure with its exit code (1 failed, 2 bad usage).
#[derive(Debug)]
pub struct CliError {
    pub message: String,
    pub code: i32,
}

impl CliError {
    pub fn fail(m: impl Into<String>) -> Self {
        CliError { message: m.into(), code: 1 }
    }
    pub fn usage(m: impl Into<String>) -> Self {
        CliError { message: format!("{} Run conclave-daemon --help.", m.into()), code: 2 }
    }
}

type R<T> = Result<T, CliError>;

pub fn print(line: &str) {
    let mut o = std::io::stdout();
    let _ = writeln!(o, "{line}");
    let _ = o.flush();
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const BOOL_FLAGS: &[&str] = &["help", "version", "json", "dry-run", "app-token-stdin", "keep-pairing", "start", "login-path"];
const STRING_FLAGS: &[&str] = &["hub", "name", "code", "log"];

#[derive(Default, Debug)]
pub struct Args {
    pub pos: Vec<String>,
    pub flags: Map<String, Value>,
}

impl Args {
    pub fn parse(argv: &[String]) -> Args {
        let mut a = Args::default();
        let mut i = 0;
        while i < argv.len() {
            let arg = &argv[i];
            i += 1;
            if arg == "--" {
                a.pos.extend(argv[i..].iter().cloned());
                break;
            }
            let short = match arg.as_str() {
                "-h" => Some("help"),
                "-v" | "-V" => Some("version"),
                "-n" => Some("name"),
                _ => None,
            };
            let (name, inline) = if let Some(s) = short {
                (s.to_string(), None)
            } else if let Some(rest) = arg.strip_prefix("--") {
                match rest.split_once('=') {
                    Some((k, v)) => (k.to_string(), Some(v.to_string())),
                    None => (rest.to_string(), None),
                }
            } else {
                a.pos.push(arg.clone());
                continue;
            };
            if let Some(n) = name.strip_prefix("no-").filter(|n| BOOL_FLAGS.contains(n)) {
                a.flags.insert(n.into(), json!(false));
                continue;
            }
            if BOOL_FLAGS.contains(&name.as_str()) {
                a.flags.insert(name, json!(inline.map(|v| v != "false").unwrap_or(true)));
                continue;
            }
            let value = match inline {
                Some(v) => Some(v),
                None if STRING_FLAGS.contains(&name.as_str()) || argv.get(i).is_some_and(|n| !n.starts_with('-')) => {
                    let v = argv.get(i).cloned();
                    if v.is_some() {
                        i += 1;
                    }
                    v
                }
                None => None,
            };
            a.flags.insert(name, value.map(Value::String).unwrap_or(json!(true)));
        }
        a
    }

    pub fn bool(&self, k: &str) -> bool {
        self.flags.get(k).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn str(&self, k: &str) -> Option<String> {
        self.flags.get(k).and_then(Value::as_str).map(str::to_string)
    }
}

// ---------------------------------------------------------------------------
// Hub requests
// ---------------------------------------------------------------------------

struct Reply {
    status: u16,
    body: Value,
    reason: String,
}

async fn hub_request(method: &str, url: &str, bearer: Option<&str>, device: Option<&str>, body: Option<Value>, timeout: Duration) -> R<Reply> {
    let auth = bearer.map(|t| format!("Bearer {t}"));
    let mut headers: Vec<(&str, &str)> = Vec::new();
    if let Some(a) = &auth {
        headers.push(("Authorization", a));
    }
    if let Some(d) = device {
        headers.push(("x-conclave-device", d));
    }
    let payload = body.map(|b| b.to_string());
    if payload.is_some() {
        headers.push(("Content-Type", "application/json"));
    }
    let res = crate::net::request(method, url, &headers, payload.as_deref().map(str::as_bytes), timeout).await.map_err(CliError::fail)?;
    let text = String::from_utf8_lossy(&res.body);
    let body = serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({}));
    Ok(Reply { status: res.status, body, reason: res.reason })
}

/// hubJson + describeError: the hub's error text for a failed request.
fn hub_error(r: &Reply) -> CliError {
    let said = r.body.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| r.reason.clone());
    if r.status == 401 {
        return CliError::fail("Unauthorized (401). The token is missing or wrong.");
    }
    if r.status == 404 && said.to_lowercase().contains("not found") {
        return CliError::fail(format!("Not found (404): {said}"));
    }
    CliError::fail(format!("Hub error {}: {said}", r.status))
}

fn ok(r: &Reply) -> bool {
    (200..300).contains(&r.status)
}

/// Trade a device code for this machine's device token and save it.
async fn register_with_code(hub: &str, code: &str, name: &str) -> R<(String, String)> {
    let body = json!({ "code": crate::js::trim(code), "name": name, "platform": crate::info::platform() });
    let r = hub_request("POST", &format!("{hub}/api/daemon/register"), None, None, Some(body), Duration::from_secs(20)).await?;
    if !ok(&r) {
        return Err(hub_error(&r));
    }
    let device_id = r.body.get("deviceId").or_else(|| r.body.get("id")).and_then(Value::as_str).map(str::to_string);
    let token = r.body.get("token").and_then(Value::as_str).map(str::to_string);
    let (Some(device_id), Some(token)) = (device_id, token) else { return Err(CliError::fail("Hub reply is missing deviceId or token.")) };
    let addresses: Vec<Value> = r.body.get("addresses").and_then(Value::as_array).map(|a| a.iter().filter(|x| x.is_string()).cloned().collect()).unwrap_or_default();
    let mut file = Map::new();
    file.insert("hub".into(), json!(hub));
    file.insert("deviceId".into(), json!(device_id));
    file.insert("token".into(), json!(token));
    file.insert("name".into(), json!(name));
    file.insert("savedAt".into(), json!(now_ms()));
    if !addresses.is_empty() {
        file.insert("addresses".into(), Value::Array(addresses));
    }
    write_private_json(&config::device_file(), &Value::Object(file)).map_err(|e| CliError::fail(format!("Cannot save {}: {e}", config::device_file().display())))?;
    Ok((device_id, name.to_string()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Paired {
    hub: String,
    device_id: String,
    name: String,
    kept: bool,
}

/// Pair with the token of an app that is already paired (the desktop app).
async fn pair_with_app_token(hub: &str, app_token: &str, name: &str) -> R<Paired> {
    let r = hub_request("GET", &format!("{hub}/api/devices"), Some(app_token), None, None, Duration::from_secs(15)).await?;
    if r.status == 401 {
        return Err(CliError::fail("The hub did not accept the app token. Connect the app to the hub again."));
    }
    if !ok(&r) {
        return Err(hub_error(&r));
    }
    if let Some(now) = read_device() {
        let listed = r.body.as_array().is_some_and(|a| a.iter().any(|d| d.get("id").and_then(Value::as_str) == Some(now.device_id.as_str())));
        if listed {
            // the same device on the same hub (by id: an address may differ). Follow the address the app uses.
            if normalize_hub_url(&now.hub) != hub {
                let mut raw = now.raw.clone();
                raw.insert("hub".into(), json!(hub));
                write_private_json(&config::device_file(), &Value::Object(raw)).map_err(|e| CliError::fail(e.to_string()))?;
            }
            return Ok(Paired { hub: hub.into(), device_id: now.device_id, name: now.name.unwrap_or_default(), kept: true });
        }
        unpair_here().await;
    }
    let r = hub_request("POST", &format!("{hub}/api/daemon/pairing"), Some(app_token), None, None, Duration::from_secs(15)).await?;
    if r.status == 404 {
        return Err(CliError::fail("This hub is too old to pair the app daemon. Update the hub first."));
    }
    if !ok(&r) {
        return Err(hub_error(&r));
    }
    let Some(code) = r.body.get("code").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string) else {
        return Err(CliError::fail("Hub reply is missing the device code."));
    };
    let (device_id, name) = register_with_code(hub, &code, name).await?;
    Ok(Paired { hub: hub.into(), device_id, name, kept: false })
}

/// What /api/daemon/unpair says for a device it does not know.
const NOT_PAIRED: &str = "This device is not paired with this hub.";

#[derive(Default)]
struct Unpaired {
    was_paired: bool,
    removed_on_hub: bool,
    hub: Option<String>,
    device_id: Option<String>,
    name: Option<String>,
    error: Option<String>,
}

/// The hub forgets this machine (its own device token proves who asks), then the local pairing goes.
async fn unpair_here() -> Unpaired {
    let Some(creds) = read_device() else { return Unpaired::default() };
    let mut removed = false;
    let mut error: Option<String> = None;
    let mut hubs: Vec<String> = Vec::new();
    for h in std::iter::once(creds.hub.clone()).chain(creds.addresses.iter().cloned()) {
        let n = normalize_hub_url(&h);
        if !hubs.contains(&n) {
            hubs.push(n);
        }
    }
    for hub in hubs {
        match hub_request("POST", &format!("{hub}/api/daemon/unpair"), Some(&creds.token), Some(&creds.device_id), None, Duration::from_secs(8)).await {
            Ok(r) => {
                let said = r.body.get("error").and_then(Value::as_str).map(str::to_string);
                // the hub no longer knows this device: the same outcome. An older hub without this route says only "unauthorized".
                removed = ok(&r) || (r.status == 401 && said.as_deref() == Some(NOT_PAIRED));
                error = if removed {
                    None
                } else if r.status == 401 {
                    Some("This hub is too old to remove a device by itself.".into())
                } else {
                    Some(match said {
                        Some(s) => format!("The hub answered HTTP {}: {s}", r.status),
                        None => format!("The hub answered HTTP {}.", r.status),
                    })
                };
                break;
            }
            Err(e) => error = Some(format!("Cannot reach {hub}: {}", e.message)),
        }
    }
    let _ = std::fs::remove_file(config::device_file());
    Unpaired { was_paired: true, removed_on_hub: removed, hub: Some(creds.hub), device_id: Some(creds.device_id), name: creds.name, error }
}

/// The app's token, one line on stdin, never on the command line.
fn read_stdin_line() -> String {
    let mut s = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut s);
    crate::js::trim(s.split('\n').next().unwrap_or("")).to_string()
}

async fn cmd_pair(args: &Args) -> R<i32> {
    let hub_arg = args.str("hub").or_else(|| args.pos.get(1).cloned());
    let Some(hub_arg) = hub_arg else { return Err(CliError::usage("pair needs --hub URL.")) };
    let hub = normalize_hub_url(&hub_arg);
    let name = args.str("name").unwrap_or_else(crate::info::hostname);
    let r = if args.bool("app-token-stdin") {
        let token = read_stdin_line();
        if token.is_empty() {
            return Err(CliError::usage("No app token on stdin."));
        }
        pair_with_app_token(&hub, &token, &name).await?
    } else if let Some(code) = args.str("code").or_else(|| args.pos.get(2).cloned()) {
        let (device_id, name) = register_with_code(&hub, &code, &name).await?;
        Paired { hub: hub.clone(), device_id, name, kept: false }
    } else {
        return Err(CliError::usage("pair needs --app-token-stdin or --code CODE."));
    };
    if args.bool("json") {
        print(&json!({ "paired": true, "hub": r.hub, "deviceId": r.device_id, "name": r.name, "kept": r.kept }).to_string());
    } else {
        print(&format!("{} {} as device {} with {}", if r.kept { "Already paired" } else { "Paired" }, r.name, r.device_id, r.hub));
    }
    Ok(0)
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

fn self_exe() -> String {
    std::env::current_exe().ok().and_then(|p| std::fs::canonicalize(&p).ok().or(Some(p))).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "conclave-daemon".into())
}

#[cfg(unix)]
fn uid() -> Option<u32> {
    // SAFETY: getuid never fails.
    Some(unsafe { libc::getuid() })
}

#[cfg(not(unix))]
fn uid() -> Option<u32> {
    None
}

fn log_file() -> String {
    config::logs_dir().join("daemon.log").to_string_lossy().into_owned()
}

/// The service for this machine: what it runs, with which PATH.
pub fn plan_for(login_path: bool, hub: Option<&str>) -> R<Plan> {
    let os = crate::info::platform();
    let home = crate::paths::home_dir();
    let mut cmd = vec![self_exe(), "run".to_string()];
    if let Some(h) = hub {
        cmd.extend(["--hub".to_string(), h.to_string()]);
    }
    if os == "win32" {
        cmd.extend(["--log".to_string(), log_file()]);
    }
    let input = service::Input {
        os,
        home: &home,
        cmd,
        path_env: service::daemon_path(login_path, os, &home),
        conclave_home: std::env::var("CONCLAVE_HOME").ok().filter(|v| !v.is_empty()),
        log_file: log_file(),
        uid: uid(),
    };
    service::plan(&input).map_err(CliError::fail)
}

fn show_steps(title: &str, steps: &[Step]) {
    if steps.is_empty() {
        return;
    }
    print(title);
    for s in steps {
        print(&format!("  {}{}", s.show, if s.optional { "   (may fail when it is not loaded)" } else { "" }));
    }
}

/// Start the daemon in the background where no service manager does it (Windows).
fn spawn_detached(s: &Step) {
    service::stop_by_pid(&service::pid_file());
    let mut cmd = std::process::Command::new(&s.argv[0]);
    cmd.args(&s.argv[1..]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let _ = cmd.spawn();
}

fn cmd_install(args: &Args) -> R<i32> {
    // started from a menu, the app has a short PATH: the service gets the login shell's
    let hub = args.str("hub");
    let plan = plan_for(true, hub.as_deref())?;
    if args.bool("dry-run") {
        print("# conclave-daemon install --dry-run: nothing is written or started");
        if let Some(f) = &plan.file {
            print(&format!("Would write {f}"));
        }
        if let Some(c) = &plan.content {
            print(c.strip_suffix('\n').unwrap_or(c));
        }
        let steps: Vec<Step> = plan.register.iter().chain(plan.start.iter()).cloned().collect();
        show_steps("Would run", &steps);
        return Ok(0);
    }
    let _ = std::fs::create_dir_all(config::logs_dir());
    if let (Some(f), Some(c)) = (&plan.file, &plan.content) {
        if let Some(dir) = std::path::Path::new(f).parent() {
            std::fs::create_dir_all(dir).map_err(|e| CliError::fail(format!("Cannot create {}: {e}", dir.display())))?;
        }
        std::fs::write(f, c).map_err(|e| CliError::fail(format!("Cannot write {f}: {e}")))?;
        print(&format!("✓ Wrote {f}"));
    }
    service::run_steps(&plan.register, &spawn_detached).map_err(CliError::fail)?;
    if plan.kind == service::Kind::RunKey {
        print("✓ It starts when you sign in to Windows.");
    }
    if read_device().is_none() {
        return Err(CliError::fail("Not paired, so it cannot start. Pair this machine first."));
    }
    service::run_steps(&plan.start, &spawn_detached).map_err(CliError::fail)?;
    print("✓ Started. It runs at login from now on.");
    Ok(0)
}

async fn cmd_uninstall(args: &Args) -> R<i32> {
    let plan = plan_for(false, None)?;
    if args.bool("dry-run") {
        print("# conclave-daemon uninstall --dry-run: nothing is stopped or removed");
        show_steps("Would run", &plan.stop);
        if let Some(f) = &plan.file {
            print(&format!("Would remove {f}"));
        }
        show_steps("Then", &plan.cleanup);
        return Ok(0);
    }
    let installed = service::installed(&plan);
    service::run_steps(&plan.stop, &spawn_detached).map_err(CliError::fail)?;
    if let Some(f) = &plan.file {
        let _ = std::fs::remove_file(f);
    }
    service::run_steps(&plan.cleanup, &spawn_detached).map_err(CliError::fail)?;
    // a daemon started by hand or by the Run key is not stopped by a service manager
    service::stop_by_pid(&service::pid_file());
    let u = if args.bool("keep-pairing") { None } else { Some(unpair_here().await) };
    let was = u.as_ref().is_some_and(|u| u.was_paired);
    let on_hub = u.as_ref().is_some_and(|u| u.removed_on_hub);
    if args.bool("json") {
        let error = if was && !on_hub { Some(u.as_ref().and_then(|u| u.error.clone()).unwrap_or_else(|| "The hub did not answer.".into())) } else { None };
        print(
            &json!({
                "removed": installed,
                "unpaired": was,
                "removedOnHub": on_hub,
                "name": u.as_ref().and_then(|u| u.name.clone()),
                "deviceId": u.as_ref().and_then(|u| u.device_id.clone()),
                "error": error,
            })
            .to_string(),
        );
        return Ok(0);
    }
    print(if installed { "Stopped and removed the service." } else { "No service was installed." });
    if let Some(u) = u.filter(|u| u.was_paired) {
        let name = u.name.clone().unwrap_or_default();
        if u.removed_on_hub {
            print(&format!("The hub removed {name}."));
        } else {
            print(&format!("{} Remove {name} on the hub's Devices page.", u.error.unwrap_or_else(|| "The hub did not answer.".into())));
        }
    }
    Ok(0)
}

/// Put back <binary>.prev, the version the last update replaced (update.rs keeps it).
fn cmd_rollback() -> R<i32> {
    let exe = std::env::current_exe().and_then(std::fs::canonicalize).map_err(|e| CliError::fail(format!("Cannot find this binary: {e}")))?;
    if !crate::update::roll_back(&exe) {
        return Err(CliError::fail(format!("There is no previous version next to {}.", exe.display())));
    }
    print(&format!("✓ Put the previous version back at {}. Restart the service to run it: conclave-daemon install", exe.display()));
    Ok(0)
}

async fn cmd_unpair(args: &Args) -> R<i32> {
    let u = unpair_here().await;
    if args.bool("json") {
        let v = if u.was_paired {
            let mut o = json!({ "paired": false, "removedOnHub": u.removed_on_hub, "hub": u.hub, "deviceId": u.device_id, "name": u.name });
            if let Some(e) = u.error {
                o["error"] = json!(e);
            }
            o
        } else {
            json!({ "paired": false })
        };
        print(&v.to_string());
        return Ok(0);
    }
    if !u.was_paired {
        print("This machine is not paired.");
        return Ok(0);
    }
    print(&format!("✓ Forgot the pairing with {}.", u.hub.unwrap_or_default()));
    let name = u.name.unwrap_or_default();
    if u.removed_on_hub {
        print(&format!("  The hub removed {name}."));
    } else {
        print(&format!("  {} Remove {name} on the hub's Devices page.", u.error.unwrap_or_else(|| "The hub did not answer.".into())));
    }
    Ok(0)
}

/// The seven keys of the contract, in its order.
pub fn status_json() -> R<Value> {
    let plan = plan_for(false, None)?;
    let creds = read_device();
    let installed = service::installed(&plan);
    // a daemon started by hand (or by the Run key) counts too: its pid file says so
    let mut running: Option<bool> = Some(service::pid_alive(service::read_pid(&service::pid_file())));
    if let (Some(probe), Some(false)) = (&plan.probe, running) {
        let r = service::run_step(probe, Duration::from_secs(5));
        // systemctl is-active: 0 active, 3 inactive; a missing systemctl or launchctl gives no status
        running = if r.ok { Some(true) } else if r.status.is_none() { None } else { Some(false) };
        if plan.kind == service::Kind::Launchd && r.ok {
            running = Some(r.stdout.contains("state = running"));
        }
    }
    let mut o = Map::new();
    o.insert("version".into(), json!(VERSION));
    o.insert("paired".into(), json!(creds.is_some()));
    o.insert("hub".into(), creds.as_ref().map(|c| json!(c.hub)).unwrap_or(Value::Null));
    o.insert("deviceId".into(), creds.as_ref().map(|c| json!(c.device_id)).unwrap_or(Value::Null));
    o.insert("name".into(), creds.as_ref().and_then(|c| c.name.clone()).map(Value::String).unwrap_or(Value::Null));
    o.insert("installed".into(), json!(installed));
    o.insert("running".into(), running.map(Value::Bool).unwrap_or(Value::Null));
    Ok(Value::Object(o))
}

fn cmd_status(args: &Args) -> R<i32> {
    let s = status_json()?;
    if args.bool("json") {
        print(&s.to_string());
    } else if let Value::Object(o) = &s {
        let lines: Vec<String> = o
            .iter()
            .map(|(k, v)| {
                let shown = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                format!("{k:<9} {shown}")
            })
            .collect();
        print(&lines.join("\n"));
    }
    Ok(0)
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

fn stamp_utc() -> (String, String) {
    let ms = now_ms();
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil from days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (format!("{y:04}-{m:02}-{d:02}"), format!("{:02}:{:02}:{:02}", rem / 3600, (rem / 60) % 60, rem % 60))
}

fn write_pid_file() {
    let v = json!({ "pid": std::process::id(), "startedAt": now_ms(), "version": VERSION });
    let _ = std::fs::create_dir_all(config::conclave_home());
    let _ = std::fs::write(service::pid_file(), v.to_string() + "\n");
}

async fn cmd_run(args: &Args) -> R<i32> {
    let Some(creds) = read_device() else {
        return Err(CliError::fail("This machine is not paired. Run `conclave-daemon pair --hub URL --code CODE` first."));
    };
    let pinned = args.str("hub");
    let hub = normalize_hub_url(pinned.as_deref().unwrap_or(&creds.hub));
    let name = args.str("name").or_else(|| creds.name.clone()).unwrap_or_else(crate::info::hostname);
    // --log FILE: where the status lines go when nobody sees stdout (the Windows Run key)
    let log = args.str("log");
    if let Some(l) = &log {
        if let Some(dir) = std::path::Path::new(l).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
    }
    let say = std::sync::Arc::new(move |line: &str| {
        // the hub's logs export asks for these lines (the logTail RPC)
        let (day, time) = stamp_utc();
        crate::logring::push(&format!("{day}T{time}Z {line}"));
        match &log {
            None => print(line),
            Some(file) => {
                if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
                    let _ = writeln!(f, "{day} {line}");
                }
            }
        }
    });
    say(&format!("◆ conclave-daemon {VERSION} {name} ({}) -> {hub}", creds.device_id));
    // the pid file lets `status` and `uninstall` find this process where no service manager tracks it
    write_pid_file();

    let device_id = creds.device_id.clone();
    let save_addresses = pinned.is_none();
    let on_addresses = move |urls: &[String]| {
        if !save_addresses {
            return;
        }
        let Some(now) = read_device() else { return };
        let same = now.raw.get("addresses").and_then(Value::as_array).is_some_and(|a| a.len() == urls.len() && a.iter().zip(urls).all(|(x, u)| x.as_str() == Some(u.as_str())));
        if now.device_id != device_id || same {
            return;
        }
        // a daemon on the hub machine keeps its loopback address; others start next time where the hub said
        let mut raw = now.raw.clone();
        let hub = if crate::conn::is_loopback_url(&now.hub) { now.hub.clone() } else { urls[0].clone() };
        raw.insert("hub".into(), json!(hub));
        raw.insert("addresses".into(), json!(urls));
        let _ = write_private_json(&config::device_file(), &Value::Object(raw));
    };
    let say2 = say.clone();
    let on_status = move |s: &crate::conn::Status| {
        let detail = s.detail.as_ref().filter(|d| !d.is_empty()).map(|d| format!(" {d}")).unwrap_or_default();
        let retry = s.retry_in_ms.filter(|ms| *ms > 0).map(|ms| format!(" (retry in {}s)", crate::js::round(ms as f64 / 1000.0) as u64)).unwrap_or_default();
        let place = if s.state == "connecting" || s.state == "online" { s.url.as_ref().map(|u| format!(" {u}")).unwrap_or_default() } else { String::new() };
        say2(&format!("{} ● {}{place}{detail}{retry}", stamp_utc().1, s.state));
    };
    let opts = crate::conn::Options {
        hub,
        // the hub's other addresses (a quick tunnel, the same network), so a changed tunnel address is not the end
        fallbacks: if pinned.is_some() { vec![] } else { creds.addresses.clone() },
        device_id: creds.device_id.clone(),
        token: creds.token.clone(),
        name: Some(name),
        on_addresses: Box::new(on_addresses),
        on_status: Box::new(on_status),
        heartbeat: crate::conn::HEARTBEAT,
    };
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let logging = args.str("log").is_some();
    tokio::spawn(async move {
        shutdown_signal().await;
        if !logging {
            let _ = writeln!(std::io::stderr(), "\nstopping daemon...");
        }
        let _ = stop_tx.send(true);
    });
    crate::conn::run(opts, stop_rx).await;
    crate::procs::kill_all(crate::procs::Sig::Term);
    if service::read_pid(&service::pid_file()) == Some(std::process::id()) {
        let _ = std::fs::remove_file(service::pid_file());
    }
    say("stopped");
    // stragglers in the process groups we started go now (the TypeScript daemon's exit hook)
    tokio::time::sleep(Duration::from_millis(200)).await;
    crate::procs::kill_all(crate::procs::Sig::Kill);
    Ok(0)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => return std::future::pending().await,
        };
        let mut int = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(_) => return std::future::pending().await,
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async fn dispatch(args: Args) -> R<i32> {
    let sub = args.pos.first().cloned().unwrap_or_else(|| "run".into());
    if args.bool("version") || sub == "version" {
        print(VERSION);
        return Ok(0);
    }
    if args.bool("help") || sub == "help" {
        print(&usage());
        return Ok(0);
    }
    match sub.as_str() {
        "run" => cmd_run(&args).await,
        "pair" => cmd_pair(&args).await,
        // nothing else runs yet, so the blocking service commands may run on this thread
        "install" => cmd_install(&args),
        "uninstall" => cmd_uninstall(&args).await,
        "status" => cmd_status(&args),
        "unpair" => cmd_unpair(&args).await,
        "rollback" => cmd_rollback(),
        other => Err(CliError::usage(format!("Unknown command \"{other}\"."))),
    }
}

pub fn main_with(argv: Vec<String>) -> i32 {
    let args = Args::parse(&argv);
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "Error: cannot start: {e}");
            return 1;
        }
    };
    let code = match rt.block_on(dispatch(args)) {
        Ok(c) => c,
        Err(e) => {
            // one line the app shows as it is
            let _ = writeln!(std::io::stderr(), "Error: {}", e.message.replace('\n', " "));
            e.code
        }
    };
    let _ = std::io::stdout().flush();
    rt.shutdown_timeout(Duration::from_millis(100));
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(s: &[&str]) -> Args {
        Args::parse(&s.iter().map(|x| x.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn flags_parse_like_args_ts() {
        let x = a(&["pair", "--hub", "http://h", "--app-token-stdin", "--json", "--name=desk"]);
        assert_eq!(x.pos, vec!["pair"]);
        assert_eq!(x.str("hub").as_deref(), Some("http://h"));
        assert!(x.bool("app-token-stdin") && x.bool("json"));
        assert_eq!(x.str("name").as_deref(), Some("desk"));
        let y = a(&["install", "--dry-run", "-V"]);
        assert!(y.bool("dry-run") && y.bool("version"));
        let z = a(&["run", "--log", "/tmp/x.log"]);
        assert_eq!(z.str("log").as_deref(), Some("/tmp/x.log"));
    }

    #[test]
    fn utc_stamps() {
        let (d, t) = stamp_utc();
        assert_eq!(d.len(), 10);
        assert_eq!(t.len(), 8);
    }
}
