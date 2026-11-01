//! "Run the hub on this computer": the desktop app as the hub.
//!
//! The app does not carry the hub. The first time it is turned on, the app
//! downloads the release file of the `conclave` CLI with the app's own version
//! (the file install.sh uses, `conclave-<os>-<arch>.tar.gz` or
//! `conclave-windows-x64.zip`), checks it against its `.sha256`, and unpacks it
//! into its data folder. Then it runs `conclave serve` as its child, with its
//! own home (`<data>/hub`), restarts it with a growing wait when it stops on
//! its own, and connects to it as the owner with the token the hub wrote into
//! `<home>/config.json` (mode 0600, this user only).
//!
//! The child gets a pipe on stdin and `CONCLAVE_STOP_ON_STDIN_END=1`: closing
//! the pipe stops it cleanly (Windows has no SIGTERM), and when the app dies
//! the system closes the pipe, so the hub never outlives the app.
//!
//! Before the app sends a token to a port on this computer, whatever listens
//! there must sign a fresh nonce with the key in that home's `hub-key.pem`
//! (`GET /api/identity`, which needs no token). Another user's program on the
//! port cannot, so a token is never sent to it, and never over the network.
//!
//! Everything that decides (which file, the checksum, which port, adopting a
//! hub that already runs, the restart wait, the words) is a pure function
//! with tests at the end. docs/DESIGN.md 36 has the why.

use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{Arc, Condvar, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::Engine as _;
use serde::Serialize;
use tauri::Url;

/// The hub's usual port.
pub const DEFAULT_PORT: u16 = 7717;
/// Ports tried after the wanted one when it is taken.
pub const PORT_RANGE: u16 = 20;
/// Where releases are (install.sh uses the same).
pub const RELEASES: &str = "https://github.com/default-cybe/conclave/releases/download";
/// A `conclave` binary to run instead of a download (development, a build by hand).
pub const BIN_ENV: &str = "CONCLAVE_HUB_BIN";
/// Another place to download releases from (a mirror, a test server).
pub const RELEASES_ENV: &str = "CONCLAVE_HUB_RELEASES";
/// The hub stops when its stdin ends (packages/cli/src/commands/serve.ts).
const STOP_ON_STDIN_END: &str = "CONCLAVE_STOP_ON_STDIN_END";
/// The CLI binary in the release archive.
pub const EXE: &str = if cfg!(windows) { "conclave.exe" } else { "conclave" };
/// Written last into a version folder: the unpack finished.
const COMPLETE: &str = ".complete";
/// The line the app writes into hub.log before each start.
const MARK: &str = "--- conclave-desktop: hub start";
/// What the hub signs, then the nonce (packages/server/src/identity.ts).
const IDENTITY_PREFIX: &str = "conclave-hub-identity-v1\n";

// ---------------------------------------------------------------------------
// Which file
// ---------------------------------------------------------------------------

/// A release file of the CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    /// The folder in the archive, e.g. conclave-linux-x64.
    pub name: String,
    /// e.g. conclave-linux-x64.tar.gz or conclave-windows-x64.zip.
    pub file: String,
}

impl Asset {
    pub fn is_zip(&self) -> bool {
        self.file.ends_with(".zip")
    }
}

/// The release file for an OS and CPU as Rust names them (std::env::consts).
/// Only the files the release workflow builds (release.yml, the cli job).
pub fn asset_for(os: &str, arch: &str, baseline: bool) -> Option<Asset> {
    let target = match (os, arch) {
        ("linux", "x86_64") if baseline => "linux-x64-baseline",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        ("windows", "x86_64") => "windows-x64",
        _ => return None,
    };
    let name = format!("conclave-{target}");
    let ext = if os == "windows" { "zip" } else { "tar.gz" };
    Some(Asset { file: format!("{name}.{ext}"), name })
}

/// The file for this computer. An Intel Mac build under Rosetta gets the
/// Apple silicon hub, and a Linux CPU without AVX2 the baseline one, as
/// install.sh picks them.
pub fn this_asset() -> Result<Asset, String> {
    let mut arch = std::env::consts::ARCH;
    if cfg!(target_os = "macos") && arch == "x86_64" && under_rosetta() {
        arch = "aarch64";
    }
    let baseline = arch == "x86_64" && !has_avx2();
    asset_for(std::env::consts::OS, arch, baseline).ok_or_else(|| format!("There is no hub for {} on {arch} yet.", std::env::consts::OS))
}

fn under_rosetta() -> bool {
    Command::new("sysctl")
        .args(["-n", "sysctl.proc_translated"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
        .unwrap_or(false)
}

fn has_avx2() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::arch::is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        true
    }
}

/// `<base>/v<version>/<file>`.
pub fn release_url(base: &str, version: &str, file: &str) -> String {
    format!("{}/v{}/{file}", base.trim_end_matches('/'), version.trim_start_matches('v'))
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

/// The hash in a .sha256 file: `<64 hex>  <name>` as sha256sum writes it, or the hash alone.
pub fn parse_sha256(text: &str) -> Option<String> {
    let first = text.split_whitespace().next()?;
    (first.len() == 64 && first.chars().all(|c| c.is_ascii_hexdigit())).then(|| first.to_ascii_lowercase())
}

pub fn sha256_hex(mut from: impl Read) -> std::io::Result<String> {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(ctx.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

/// The file's SHA-256 must be `expected`, else it is not used.
pub fn check_sha256(file: &Path, expected: &str, name: &str) -> Result<(), String> {
    let f = fs::File::open(file).map_err(|e| format!("Cannot read the download: {e}"))?;
    let actual = sha256_hex(f).map_err(|e| format!("Cannot read the download: {e}"))?;
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!("The download of {name} is damaged: its SHA-256 does not match {name}.sha256. Try again."))
    }
}

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

/// The hub's files in the app's data folder.
#[derive(Debug, Clone)]
pub struct Layout {
    pub data: PathBuf,
}

impl Layout {
    /// CONCLAVE_HOME of the app's hub: config, database, keys, logs.
    pub fn home(&self) -> PathBuf {
        self.data.join("hub")
    }

    /// The unpacked releases, one folder per version.
    pub fn bins(&self) -> PathBuf {
        self.data.join("hub-bin")
    }

    fn version_dir(&self, version: &str) -> PathBuf {
        self.bins().join(format!("v{}", version.trim_start_matches('v')))
    }

    /// stdout and stderr of the hub. Its own log files are next to it (<home>/logs/hub-<day>.jsonl).
    pub fn log_file(&self) -> PathBuf {
        self.home().join("logs").join("hub.log")
    }

    /// The hub of this version, when it is unpacked in full.
    pub fn installed(&self, version: &str, asset: &Asset) -> Option<PathBuf> {
        let dir = self.version_dir(version);
        let exe = dir.join(&asset.name).join(EXE);
        (exe.is_file() && dir.join(COMPLETE).is_file()).then_some(exe)
    }

    /// The newest complete version here, for when this version cannot be downloaded.
    pub fn newest_installed(&self, asset: &Asset) -> Option<(String, PathBuf)> {
        let mut found: Vec<(String, PathBuf)> = fs::read_dir(self.bins())
            .ok()?
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let version = name.strip_prefix('v')?.to_string();
                self.installed(&version, asset).map(|exe| (version, exe))
            })
            .collect();
        found.sort_by_key(|(v, _)| version_key(v));
        found.pop()
    }

    /// Remove the versions other than `keep` (one still running on Windows stays until next time).
    /// Not while a download unpacks: the hub and the terminal command (terminal.rs) both get versions.
    pub fn prune(&self, keep: &str) {
        let _one = INSTALLS.lock().unwrap_or_else(|e| e.into_inner());
        let keep = self.version_dir(keep);
        for e in fs::read_dir(self.bins()).into_iter().flatten().flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if path != keep && (name.starts_with('v') || name.starts_with(".stage-")) {
                let _ = fs::remove_dir_all(&path);
            }
        }
    }
}

/// "0.12.3" sorts after "0.9.1"; a pre-release tag sorts by its numbers only.
pub fn version_key(v: &str) -> Vec<u64> {
    v.split(['.', '-', '+']).map(|p| p.parse::<u64>().unwrap_or(0)).collect()
}

/// server.token from `<home>/config.json`, where the hub writes it on its first start.
pub fn home_token(home: &Path) -> Option<String> {
    let text = fs::read_to_string(home.join("config.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("server")?.get("token")?.as_str().filter(|t| !t.is_empty()).map(str::to_string)
}

/// The port a `conclave serve` of this home listens on when started plainly:
/// `server.port` in its config.json, else 7717 (packages/cli/src/hub.ts readLocalHub).
pub fn home_port(home: &Path) -> u16 {
    fs::read_to_string(home.join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("server")?.get("port")?.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .unwrap_or(DEFAULT_PORT)
}

/// A home with its hub's public key (`<home>/hub-key.pem`, Ed25519 PKCS#8, made on the hub's first start).
pub fn home_key(home: &Path) -> Option<Vec<u8>> {
    public_key_from_pem(&fs::read_to_string(home.join("hub-key.pem")).ok()?)
}

/// The 32-byte public key of an Ed25519 private key in PEM (PKCS#8 v1 or v2).
pub fn public_key_from_pem(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("-----")).collect();
    let der = base64::engine::general_purpose::STANDARD.decode(body).ok()?;
    let pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&der).ok()?;
    Some(ring::signature::KeyPair::public_key(&pair).as_ref().to_vec())
}

// ---------------------------------------------------------------------------
// Download and unpack
// ---------------------------------------------------------------------------

/// What `install` is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Download { done: u64, total: Option<u64> },
    Unpack,
}

/// Downloads go through the proxy the system names (HTTPS_PROXY), as a
/// browser's would, except to this computer and to hosts in NO_PROXY.
fn download_agent(url: &str) -> ureq::Agent {
    let host = Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let no_proxy = std::env::var("NO_PROXY").or_else(|_| std::env::var("no_proxy")).unwrap_or_default();
    ureq::AgentBuilder::new()
        .resolver(crate::hub::Ipv4First)
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .try_proxy_from_env(uses_proxy(&host, &no_proxy))
        .build()
}

/// A host goes through the proxy unless it is this computer or NO_PROXY names it (or a domain above it).
pub fn uses_proxy(host: &str, no_proxy: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()) {
        return false;
    }
    !no_proxy.split(',').map(|e| e.trim().trim_start_matches("*.").trim_start_matches('.').to_ascii_lowercase()).filter(|e| !e.is_empty()).any(|e| e == "*" || host == e || host.ends_with(&format!(".{e}")))
}

fn fetch_error(url: &str, err: ureq::Error) -> String {
    match err {
        ureq::Error::Status(404, _) => format!("{url} is not there."),
        ureq::Error::Status(status, _) => format!("The server answered HTTP {status} for {url}."),
        ureq::Error::Transport(t) => format!("Cannot reach {}: {t}.", Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| url.to_string())),
    }
}


/// Download `url` into `to`, saying how far it got. Stops when `keep_going` says no.
fn fetch(agent: &ureq::Agent, url: &str, to: &Path, progress: &mut dyn FnMut(u64, Option<u64>), keep_going: &dyn Fn() -> bool) -> Result<(), String> {
    let resp = agent.get(url).call().map_err(|e| fetch_error(url, e))?;
    let total = resp.header("content-length").and_then(|v| v.parse::<u64>().ok());
    let mut body = resp.into_reader();
    let mut out = fs::File::create(to).map_err(|e| format!("Cannot write {}: {e}", to.display()))?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    progress(0, total);
    loop {
        if !keep_going() {
            return Err("Stopped.".into());
        }
        let n = body.read(&mut buf).map_err(|e| format!("The download stopped: {e}. Check the connection and try again."))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| format!("Cannot write {}: {e}", to.display()))?;
        done += n as u64;
        progress(done, total);
    }
    out.flush().map_err(|e| format!("Cannot write {}: {e}", to.display()))?;
    if total.is_some_and(|t| t != done) {
        return Err("The download stopped before the end. Check the connection and try again.".into());
    }
    Ok(())
}

/// A small text file. The error says whether it is missing (404).
fn fetch_text(agent: &ureq::Agent, url: &str) -> Result<String, (bool, String)> {
    let resp = agent.get(url).call().map_err(|e| (matches!(e, ureq::Error::Status(404, _)), fetch_error(url, e)))?;
    let mut text = String::new();
    resp.into_reader().take(4096).read_to_string(&mut text).map_err(|e| (false, format!("The download stopped: {e}.")))?;
    Ok(text)
}

/// The tar of the system: bsdtar on macOS and Windows (which unpacks .zip too), GNU tar on Linux.
fn tar_program() -> PathBuf {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        root.join("System32").join("tar.exe")
    }
    #[cfg(not(windows))]
    {
        ["/usr/bin/tar", "/bin/tar"].iter().map(PathBuf::from).find(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("tar"))
    }
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn unpack(archive: &Path, zip: bool, into: &Path) -> Result<(), String> {
    let tar = tar_program();
    let mut cmd = Command::new(&tar);
    cmd.arg(if zip { "-xf" } else { "-xzf" }).arg(archive).arg("-C").arg(into).stdin(Stdio::null());
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Cannot unpack the hub: {} did not start ({e}).", tar.display()))?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    let line = said.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("no message");
    Err(format!("Cannot unpack the hub: {line}"))
}

/// One download or prune at a time: the hub's supervisor and the terminal
/// command (terminal.rs) both want the binary of the app's version.
static INSTALLS: Mutex<()> = Mutex::new(());

/// The `conclave` binary of `version`: the one unpacked here, else a download
/// of it. Waits while another download runs, then uses what it unpacked.
pub fn ensure(layout: &Layout, base: &str, version: &str, asset: &Asset, step: &mut dyn FnMut(Step), keep_going: &dyn Fn() -> bool) -> Result<PathBuf, String> {
    let _one = INSTALLS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(exe) = layout.installed(version, asset) {
        return Ok(exe);
    }
    install(layout, base, version, asset, step, keep_going)
}

/// Download the hub of `version`, check it, unpack it into its own folder.
/// Returns the path of the `conclave` binary.
pub fn install(layout: &Layout, base: &str, version: &str, asset: &Asset, step: &mut dyn FnMut(Step), keep_going: &dyn Fn() -> bool) -> Result<PathBuf, String> {
    let bins = layout.bins();
    fs::create_dir_all(&bins).map_err(|e| format!("Cannot make {}: {e}", bins.display()))?;
    let url = release_url(base, version, &asset.file);
    let agent = download_agent(&url);
    let missing = || format!("Hub {version} for this computer ({}) is not in the release: {url}", asset.file);
    let sum_url = format!("{url}.sha256");
    let expected = match fetch_text(&agent, &sum_url) {
        Ok(text) => parse_sha256(&text).ok_or_else(|| format!("{sum_url} holds no SHA-256."))?,
        Err((true, _)) => return Err(missing()),
        Err((false, e)) => return Err(format!("Cannot download the hub. {e} Check the connection and try again.")),
    };
    let part = bins.join(format!(".{}.part", asset.file));
    let result = (|| {
        fetch(&agent, &url, &part, &mut |done, total| step(Step::Download { done, total }), keep_going).map_err(|e| if e.ends_with("is not there.") { missing() } else { e })?;
        step(Step::Unpack);
        check_sha256(&part, &expected, &asset.file)?;
        let stage = bins.join(format!(".stage-v{}", version.trim_start_matches('v')));
        let _ = fs::remove_dir_all(&stage);
        fs::create_dir_all(&stage).map_err(|e| format!("Cannot make {}: {e}", stage.display()))?;
        let unpacked = unpack(&part, asset.is_zip(), &stage).and_then(|_| {
            let exe = stage.join(&asset.name).join(EXE);
            if !exe.is_file() {
                return Err(format!("The archive has no {}/{EXE}.", asset.name));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
            }
            let dir = layout.version_dir(version);
            let _ = fs::remove_dir_all(&dir);
            fs::rename(&stage, &dir).map_err(|e| format!("Cannot move the hub into {}: {e}", dir.display()))?;
            fs::write(dir.join(COMPLETE), &expected).map_err(|e| e.to_string())?;
            Ok(dir.join(&asset.name).join(EXE))
        });
        if unpacked.is_err() {
            let _ = fs::remove_dir_all(&stage);
        }
        unpacked
    })();
    let _ = fs::remove_file(&part);
    result
}

// ---------------------------------------------------------------------------
// Which port, and a hub that already runs here
// ---------------------------------------------------------------------------

/// Whose hub proved its key on a port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    /// The app's own home (<data>/hub).
    App,
    /// The CLI's home of this user ($CONCLAVE_HOME or ~/.conclave): a `conclave serve` started outside the app.
    User,
}

/// What listens on a port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnPort {
    Free,
    /// A hub that signed with the key of one of this user's homes.
    Ours(Owner),
    /// Anything else: another program, another user's hub, a hub in a container.
    Taken,
}

/// How the app's hub ran before.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Never: the app's home has no config.json.
    Fresh,
    /// The app's own hub ran here.
    Own,
    /// The app uses a hub it found running (conclave serve), and does not start or stop it.
    Adopted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    /// Start the app's hub on `port`. `moved_from`: the port it wanted, which is taken.
    Start { port: u16, moved_from: Option<u16> },
    /// Use the hub this user already runs on `port` (started outside the app).
    Adopt { port: u16 },
    /// The app's own hub still answers there (one from before, stopping or left behind).
    Leftover { port: u16 },
    /// The adopted hub is not running now: wait for it.
    Absent { port: u16 },
    /// Every port from `from` to `to` is taken.
    NoPort { from: u16, to: u16 },
}

/// Decide where the hub runs. `probe` says what is on a port.
pub fn plan(preferred: u16, mode: Mode, probe: &mut dyn FnMut(u16) -> OnPort) -> Plan {
    let here = probe(preferred);
    match (mode, here) {
        (Mode::Adopted, OnPort::Ours(Owner::User)) => return Plan::Adopt { port: preferred },
        (Mode::Adopted, _) => return Plan::Absent { port: preferred },
        (_, OnPort::Free) => return Plan::Start { port: preferred, moved_from: None },
        (_, OnPort::Ours(Owner::App)) => return Plan::Leftover { port: preferred },
        // the first time, this user's own `conclave serve` is the hub; later the app keeps its own data
        (Mode::Fresh, OnPort::Ours(Owner::User)) => return Plan::Adopt { port: preferred },
        _ => {}
    }
    let to = preferred.saturating_add(PORT_RANGE);
    (preferred.saturating_add(1)..=to)
        .find(|&p| probe(p) == OnPort::Free)
        .map(|port| Plan::Start { port, moved_from: Some(preferred) })
        .unwrap_or(Plan::NoPort { from: preferred, to })
}

/// http://127.0.0.1:<port>/
pub fn local_base(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}/")).expect("a loopback URL")
}

/// Nothing listens on the port: 127.0.0.1 can be bound there and does not
/// answer (which also catches a listener on every interface). Only loopback
/// is bound, so no firewall asks about the app itself. A program on one
/// other address only is caught when the hub fails to bind (see `round`).
pub fn port_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok() && TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_err()
}

/// The hub's error says it could not bind its port.
pub fn is_bind_error(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("could not listen") || e.contains("eaddrinuse") || e.contains("address in use") || e.contains("address already in use")
}

fn loopback_agent() -> ureq::Agent {
    // no proxy: loopback requests never leave this computer
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(2)).timeout(Duration::from_secs(5)).build()
}

pub fn new_nonce() -> String {
    let mut bytes = [0u8; 24];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).expect("system random");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A reply of GET /api/identity?nonce=… proves `key` when it names that key
/// and its signature of the nonce checks.
pub fn proves(key: &[u8], nonce: &str, reply: &serde_json::Value) -> bool {
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let field = |k: &str| reply.get(k).and_then(|v| v.as_str()).and_then(|s| b64.decode(s.trim_end_matches('=')).ok());
    let (Some(public), Some(signature)) = (field("publicKey"), field("signature")) else {
        return false;
    };
    public == key
        && ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
            .verify(format!("{IDENTITY_PREFIX}{nonce}").as_bytes(), &signature)
            .is_ok()
}

/// Which of `keys` the hub at `base` holds, if any. Sends no token.
pub fn who_answers(base: &Url, keys: &[(Owner, Vec<u8>)]) -> Option<Owner> {
    if keys.is_empty() {
        return None;
    }
    let nonce = new_nonce();
    let mut url = base.join("api/identity").ok()?;
    url.query_pairs_mut().append_pair("nonce", &nonce);
    let reply: serde_json::Value = loopback_agent().get(url.as_str()).call().ok()?.into_json().ok()?;
    keys.iter().find(|(_, key)| proves(key, &nonce, &reply)).map(|(owner, _)| *owner)
}

/// A signature with this user's CLI home key proves that some program can
/// reach that hub, not that it is the one listening on the port: another
/// user's program on the port could pass the nonce on to it. So that hub
/// counts only on the port it is set up for (its config.json); there the
/// other program could not listen, since the hub itself does.
pub fn trusted(found: OnPort, port: u16, user_port: Option<u16>) -> OnPort {
    match found {
        OnPort::Ours(Owner::User) if user_port != Some(port) => OnPort::Taken,
        other => other,
    }
}

/// What is on `port`, against the keys of this user's homes.
pub fn probe(port: u16, keys: &[(Owner, Vec<u8>)]) -> OnPort {
    if port_free(port) {
        return OnPort::Free;
    }
    who_answers(&local_base(port), keys).map(OnPort::Ours).unwrap_or(OnPort::Taken)
}

// ---------------------------------------------------------------------------
// Restarts
// ---------------------------------------------------------------------------

/// The wait before starting a hub that stopped on its own: 1, 2, 4, 8, 16 and
/// 32 seconds, then it gives up. A hub that ran a minute counts as healthy, so
/// the next stop starts over at 1 second.
#[derive(Debug, Default)]
pub struct Backoff {
    failures: u32,
}

impl Backoff {
    pub const HEALTHY: Duration = Duration::from_secs(60);
    pub const TRIES: u32 = 6;

    pub fn next(&mut self, ran: Duration) -> Option<Duration> {
        if ran >= Self::HEALTHY {
            self.failures = 0;
        }
        self.failures += 1;
        (self.failures <= Self::TRIES).then(|| Duration::from_secs(1 << (self.failures - 1)))
    }

    pub fn reset(&mut self) {
        self.failures = 0;
    }
}

/// The hub's last error in its own words, from hub.log after the last start:
/// the CLI's `Error: ` line, else its last ERROR log line, else the last
/// other line about an error (a crash). None when it said nothing of the kind.
pub fn last_error(log: &str) -> Option<String> {
    let run = log.rsplit_once(MARK).map(|(_, after)| after.split_once('\n').map(|(_, rest)| rest).unwrap_or("")).unwrap_or(log);
    let lines: Vec<String> = run.lines().map(strip_ansi).map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    // the hub's log lines: "<time> LEVEL [component] message"
    let level = |l: &str| {
        let mut words = l.split_whitespace();
        let time = words.next().unwrap_or("");
        let lv = words.next().unwrap_or("");
        (time.len() >= 20 && time.as_bytes()[4] == b'-' && time.contains('T')).then(|| (lv.to_string(), l[l.find(lv).unwrap_or(0) + lv.len()..].trim().to_string()))
    };
    let is_frame = |l: &str| l.starts_with("at ") || l.chars().all(|c| c == '^' || c == '~' || c.is_whitespace());
    let looks_wrong = |l: &str| {
        let low = l.to_ascii_lowercase();
        ["error", "panic", "fatal", "segmentation fault", "out of memory"].iter().any(|w| low.contains(w))
    };
    let line = lines
        .iter()
        .rev()
        .find_map(|l| l.strip_prefix("Error: ").map(str::to_string))
        .or_else(|| lines.iter().rev().find_map(|l| level(l).filter(|(lv, _)| lv == "ERROR").map(|(_, msg)| msg)))
        .or_else(|| lines.iter().rev().find(|l| level(l).is_none() && !is_frame(l) && looks_wrong(l)).cloned())?;
    Some(if line.chars().count() > 300 { format!("{}...", line.chars().take(300).collect::<String>()) } else { line })
}

/// How a process ended, in words.
pub fn exit_words(status: &ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            let name = match sig {
                9 => " (SIGKILL)",
                15 => " (SIGTERM)",
                11 => " (SIGSEGV)",
                6 => " (SIGABRT)",
                _ => "",
            };
            return format!("It was stopped by signal {sig}{name}");
        }
    }
    match status.code() {
        Some(code) => format!("It exited with code {code}"),
        None => "It exited".into(),
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for d in chars.by_ref() {
                    if d.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// The end of a log file: its last 64 KB.
fn tail(file: &Path) -> String {
    let Ok(mut f) = fs::File::open(file) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(64 * 1024);
    let _ = std::io::Seek::seek(&mut f, std::io::SeekFrom::Start(start));
    let mut bytes = Vec::new();
    let _ = f.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

// ---------------------------------------------------------------------------
// The child's environment
// ---------------------------------------------------------------------------

/// Variables that would point the hub at another home, port, address or token.
const PINNING: &[&str] = &["CONCLAVE_TOKEN", "CONCLAVE_HOST", "CONCLAVE_PORT", "CONCLAVE_HUB", "CONCLAVE_HOME", "CONCLAVE_DETACHED", STOP_ON_STDIN_END];
/// An AppImage's own variables.
const APPIMAGE_VARS: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD"];

/// The app's environment for the hub, without what pins the CLI's own hub
/// (CONCLAVE_TOKEN and the like) and without the AppImage's mount (gone once
/// the app quits; its libraries would break the hub's shells and tools).
pub fn child_env(vars: impl IntoIterator<Item = (String, String)>, appdir: Option<&str>) -> Vec<(String, String)> {
    let appdir = appdir.filter(|a| !a.is_empty());
    vars.into_iter()
        .filter(|(k, _)| {
            let up = k.to_ascii_uppercase();
            !PINNING.contains(&up.as_str()) && !(appdir.is_some() && APPIMAGE_VARS.contains(&up.as_str()))
        })
        .filter_map(|(k, v)| {
            let Some(dir) = appdir else { return Some((k, v)) };
            if !v.contains(dir) && !v.contains("/.mount_") {
                return Some((k, v));
            }
            let kept: Vec<&str> = v.split(':').filter(|p| !p.is_empty() && !p.starts_with(dir) && !p.contains("/.mount_")).collect();
            (!kept.is_empty()).then(|| (k, kept.join(":")))
        })
        .collect()
}

const PATH_MARK: &str = "__CONCLAVE_PATH__";

/// The PATH between the markers the login shell printed (rc files may print other lines).
pub fn parse_marked_path(output: &str) -> Option<String> {
    let start = output.find(PATH_MARK)? + PATH_MARK.len();
    let end = output[start..].find(PATH_MARK)? + start;
    let v = output[start..end].trim();
    (!v.is_empty()).then(|| v.to_string())
}

/// PATH lists joined in order without repeats; `extra` folders only when they exist.
pub fn merge_paths(lists: &[Option<&str>], extra: &[String], exists: &dyn Fn(&str) -> bool) -> String {
    let mut out: Vec<String> = Vec::new();
    for dir in lists.iter().flatten().flat_map(|l| l.split(':')).map(str::trim) {
        if !dir.is_empty() && !out.iter().any(|d| d == dir) {
            out.push(dir.to_string());
        }
    }
    for dir in extra {
        if !out.contains(dir) && exists(dir) {
            out.push(dir.clone());
        }
    }
    out.join(":")
}

/// The user's shell: $SHELL, else zsh on macOS and sh elsewhere.
pub fn user_shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() })
}

/// The PATH `shell` has once its startup files ran: as a login shell
/// (`-l -i`), or as the interactive shell a new terminal window opens on
/// Linux (`-i`). `env`: what it starts with (None: the app's environment).
/// None when it does not answer in 5 seconds.
pub fn shell_path(shell: &str, login: bool, env: Option<Vec<(String, String)>>) -> Option<String> {
    let script = format!("printf '%s%s%s' '{PATH_MARK}' \"$PATH\" '{PATH_MARK}'");
    let flags: &[&str] = if login { &["-l", "-i", "-c"] } else { &["-i", "-c"] };
    let mut cmd = Command::new(shell);
    cmd.args(flags).arg(&script).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(env) = env {
        cmd.env_clear().envs(env);
    }
    let mut child = cmd.spawn().ok();
    let said = child.as_mut().and_then(|c| c.stdout.take()).and_then(|mut out| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            let _ = tx.send(s);
        });
        rx.recv_timeout(Duration::from_secs(5)).ok()
    });
    if let Some(mut c) = child {
        let _ = c.kill();
        let _ = c.wait();
    }
    said.as_deref().and_then(parse_marked_path)
}

/// The login shell's PATH, so the hub finds git, claude and codex as a
/// terminal would: an app started from a menu or the Dock has a short one.
/// None on Windows (the app has the user's PATH there) or when the shell does
/// not answer in 5 seconds.
pub fn login_path(home: Option<&Path>, current: &str) -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let login = shell_path(&user_shell(), true, None);
    let mut extra: Vec<String> = Vec::new();
    if let Some(home) = home {
        for d in [".local/bin", ".bun/bin", ".cargo/bin", ".npm-global/bin", ".volta/bin", "go/bin"] {
            extra.push(home.join(d).to_string_lossy().into_owned());
        }
    }
    let system: &[&str] = if cfg!(target_os = "macos") { &["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] } else { &["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"] };
    extra.extend(system.iter().map(|s| s.to_string()));
    Some(merge_paths(&[login.as_deref(), Some(current)], &extra, &|d| Path::new(d).is_dir()))
}

// ---------------------------------------------------------------------------
// State, and the words for it
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    #[default]
    Off,
    /// Downloading the hub.
    Getting,
    /// Checking and unpacking it.
    Unpacking,
    Starting,
    /// The hub answers; the app connects to it (and pairs this computer).
    Connecting,
    Running,
    /// For a port, the hub from before, or a hub started outside the app.
    Waiting,
    /// It stopped on its own; it starts again after a wait.
    Retrying,
    /// It cannot run until the owner tries again.
    Failed,
    Stopping,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    pub port: Option<u16>,
    /// Bytes downloaded, and of how many.
    pub done: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    /// Seconds to the next start (Retrying).
    pub retry_in: Option<u64>,
    /// Started outside the app (conclave serve): the app neither starts nor stops it.
    pub external: bool,
    /// One more line: a port that moved, an older hub in use, what it waits for.
    pub note: Option<String>,
    /// The version running.
    pub version: Option<String>,
    pub pid: Option<u32>,
    /// Pairing this computer with the hub failed (the hub itself runs).
    pub computer_error: Option<String>,
}

fn mb(bytes: u64) -> String {
    let v = bytes as f64 / 1_000_000.0;
    if v < 10.0 {
        format!("{v:.1}")
    } else {
        format!("{v:.0}")
    }
}

/// The state in a sentence or two, for the app's pages.
pub fn words(s: &Status) -> String {
    let port = s.port.map(|p| p.to_string()).unwrap_or_else(|| DEFAULT_PORT.to_string());
    let mut out = match s.phase {
        Phase::Off => "Off. This computer does not run the hub.".to_string(),
        Phase::Getting => match s.total {
            Some(t) if t > 0 => format!("Downloading the hub: {} of {} MB.", mb(s.done), mb(t)),
            _ if s.done > 0 => format!("Downloading the hub: {} MB.", mb(s.done)),
            _ => "Downloading the hub.".to_string(),
        },
        Phase::Unpacking => "Checking and unpacking the hub.".to_string(),
        Phase::Starting => "Starting the hub.".to_string(),
        Phase::Connecting => "The hub is up. Connecting to it.".to_string(),
        Phase::Running if s.external => format!("Running at http://127.0.0.1:{port}. The app did not start this hub, so it does not stop it."),
        Phase::Running => format!("Running at http://127.0.0.1:{port}."),
        Phase::Waiting => return s.note.as_deref().map(sentence).unwrap_or_else(|| "Waiting for the hub.".into()),
        Phase::Retrying => {
            let why = s.error.as_deref().map(|e| format!("The hub stopped: {}", sentence(e))).unwrap_or_else(|| "The hub stopped.".into());
            match s.retry_in {
                Some(1) => format!("{why} Starting it again in 1 second."),
                Some(n) => format!("{why} Starting it again in {n} seconds."),
                None => format!("{why} Starting it again."),
            }
        }
        Phase::Failed => s.error.as_deref().map(sentence).unwrap_or_else(|| "The hub cannot start.".into()),
        Phase::Stopping => "Stopping the hub.".to_string(),
    };
    // a port that moved, an older hub in use: said while it starts and runs
    if let (Some(note), Phase::Starting | Phase::Connecting | Phase::Running) = (&s.note, s.phase) {
        out.push(' ');
        out.push_str(&sentence(note));
    }
    out
}

/// Ends with a full stop.
fn sentence(s: &str) -> String {
    let t = s.trim();
    if t.ends_with(['.', '!', '?']) {
        t.to_string()
    } else {
        format!("{t}.")
    }
}

/// The tray's status line. `remote`: the hub the app uses when it runs none.
pub fn tray_line(run_hub: bool, s: &Status, remote: Option<&str>) -> String {
    if !run_hub {
        return match remote {
            Some(host) => format!("Hub: {host}"),
            None => "Hub: not set up".into(),
        };
    }
    let state = match s.phase {
        Phase::Off | Phase::Starting | Phase::Connecting => "starting".to_string(),
        Phase::Getting => match s.total {
            Some(t) if t > 0 => format!("downloading, {}%", s.done * 100 / t),
            _ => "downloading".into(),
        },
        Phase::Unpacking => "unpacking".into(),
        Phase::Running if s.external => "running, not started by the app".into(),
        Phase::Running => format!("running on port {}", s.port.unwrap_or(DEFAULT_PORT)),
        Phase::Waiting => "waiting".into(),
        Phase::Retrying => "stopped, trying again".into(),
        Phase::Failed => "stopped, see Settings".into(),
        Phase::Stopping => "stopping".into(),
    };
    format!("Hub on this computer: {state}")
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

/// What the manager needs from the app.
pub trait Host: Send + Sync + 'static {
    /// The port the app's hub had, and whether it is a hub the app found running.
    fn saved(&self) -> (Option<u16>, bool);
    fn remember(&self, port: u16, adopted: bool);
    /// The hub at `base` proved its key and `token` is its owner token: connect the app to it.
    fn connected(&self, hub: &Hub, base: &Url, token: &str) -> Result<(), String>;
    /// The state changed (the tray line follows it).
    fn changed(&self, status: &Status);
    /// "Let phones on this Wi-Fi connect": the hub listens on every address, and its own
    /// "Devices on this network" decides. Off (the default), it listens on 127.0.0.1 only.
    fn lan(&self) -> bool {
        false
    }
}

/// What the manager is given to run.
#[derive(Debug, Clone)]
pub struct Setup {
    pub layout: Layout,
    /// The app's version: the hub of the same version is downloaded.
    pub version: String,
    pub releases: String,
    /// CONCLAVE_HUB_BIN: run this binary instead of a download.
    pub bin: Option<PathBuf>,
    /// The CLI's home of this user ($CONCLAVE_HOME or ~/.conclave): a hub running from there may be adopted.
    pub user_home: Option<PathBuf>,
    /// The user's home folder: the hub starts there.
    pub home_dir: Option<PathBuf>,
}

#[derive(Default)]
struct Inner {
    /// The switch.
    want: bool,
    /// A supervisor thread is alive.
    alive: bool,
    /// Try again now (after a failure, or during a wait).
    retry: bool,
    status: Status,
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    cv: Condvar,
}

/// The hub on this computer: one supervisor thread while it is on.
#[derive(Clone, Default)]
pub struct Hub {
    shared: Arc<Shared>,
}

impl Hub {
    pub fn status(&self) -> Status {
        self.shared.inner.lock().unwrap().status.clone()
    }

    /// Turn it on: start the supervisor, or wake it (a failed start tries again).
    pub fn start(&self, setup: Setup, host: Arc<dyn Host>) {
        let mut g = self.shared.inner.lock().unwrap();
        g.want = true;
        g.retry = true;
        if !g.alive {
            g.alive = true;
            g.status = Status { phase: Phase::Starting, ..Default::default() };
            let hub = self.clone();
            std::thread::spawn(move || supervise(hub, setup, host));
        }
        self.shared.cv.notify_all();
    }

    /// Turn it off and wait up to `wait` for the hub to stop. True when it did.
    pub fn stop(&self, wait: Duration) -> bool {
        let g = self.shared.inner.lock().unwrap();
        let mut g = g;
        g.want = false;
        self.shared.cv.notify_all();
        let (g, _) = self.shared.cv.wait_timeout_while(g, wait, |i| i.alive).unwrap();
        !g.alive
    }

    /// A supervisor runs (the hub is on, starting or stopping).
    pub fn active(&self) -> bool {
        self.shared.inner.lock().unwrap().alive
    }

    /// Try again now, after a failure or during a wait.
    pub fn retry(&self) {
        self.shared.inner.lock().unwrap().retry = true;
        self.shared.cv.notify_all();
    }

    pub fn set_computer_error(&self, error: Option<String>) {
        self.shared.inner.lock().unwrap().status.computer_error = error;
    }

    fn wanted(&self) -> bool {
        self.shared.inner.lock().unwrap().want
    }

    fn set(&self, host: &dyn Host, f: impl FnOnce(&mut Status)) {
        let status = {
            let mut g = self.shared.inner.lock().unwrap();
            f(&mut g.status);
            g.status.clone()
        };
        host.changed(&status);
    }

    /// A new phase with nothing carried over but the computer error.
    fn phase(&self, host: &dyn Host, next: Status) {
        self.set(host, |s| {
            let computer_error = s.computer_error.take();
            *s = Status { computer_error, ..next };
        });
    }

    /// Wait up to `d`. Returns early when turned off, or with `retry` when asked to try again.
    fn sleep(&self, d: Duration, wake_on_retry: bool) -> bool {
        let g = self.shared.inner.lock().unwrap();
        let (mut g, _) = self.shared.cv.wait_timeout_while(g, d, |i| i.want && !(wake_on_retry && i.retry)).unwrap();
        if wake_on_retry && g.retry {
            g.retry = false;
        }
        g.want
    }

    /// Wait until turned off or asked to try again. Returns whether it is still on.
    fn park(&self) -> bool {
        let g = self.shared.inner.lock().unwrap();
        let mut g = self.shared.cv.wait_while(g, |i| i.want && !i.retry).unwrap();
        g.retry = false;
        g.want
    }

    /// The end of the supervisor, unless it was turned on again meanwhile.
    fn finish(&self, host: &dyn Host) -> bool {
        let done = {
            let mut g = self.shared.inner.lock().unwrap();
            if g.want {
                false
            } else {
                g.alive = false;
                g.status = Status::default();
                true
            }
        };
        self.shared.cv.notify_all();
        if done {
            host.changed(&Status::default());
        }
        done
    }
}

fn supervise(hub: Hub, setup: Setup, host: Arc<dyn Host>) {
    let host = &*host;
    let mut backoff = Backoff::default();
    // ports the hub could not bind although they looked free (a program on another address only)
    let mut avoid: Vec<u16> = Vec::new();
    {
        // a start asks to try at once; that is this first round
        hub.shared.inner.lock().unwrap().retry = false;
    }
    loop {
        if !hub.wanted() && hub.finish(host) {
            return;
        }
        if hub.wanted() {
            round(&hub, &setup, host, &mut backoff, &mut avoid);
        }
    }
}

/// A failure that waits for Try again.
fn fail(hub: &Hub, host: &dyn Host, backoff: &mut Backoff, error: String) {
    hub.phase(host, Status { phase: Phase::Failed, error: Some(error), ..Default::default() });
    if hub.park() {
        backoff.reset();
    }
}

/// The binary to run, its version, and a note when it is not the app's version.
fn binary(hub: &Hub, setup: &Setup, host: &dyn Host) -> Result<(PathBuf, String, Option<String>), String> {
    if let Some(bin) = &setup.bin {
        return if bin.is_file() { Ok((bin.clone(), "dev".into(), None)) } else { Err(format!("{BIN_ENV} names {}, which is not a file.", bin.display())) };
    }
    let asset = this_asset()?;
    if let Some(exe) = setup.layout.installed(&setup.version, &asset) {
        return Ok((exe, setup.version.clone(), None));
    }
    hub.phase(host, Status { phase: Phase::Getting, ..Default::default() });
    let mut shown = (u64::MAX, Phase::Getting);
    let mut step = |s: Step| match s {
        Step::Download { done, total } => {
            // the tray and the page follow whole percents, not every chunk
            let pct = total.filter(|t| *t > 0).map(|t| done * 100 / t).unwrap_or(done / 1_000_000);
            if pct != shown.0 {
                shown.0 = pct;
                hub.set(host, |st| {
                    st.done = done;
                    st.total = total;
                });
            }
        }
        Step::Unpack if shown.1 != Phase::Unpacking => {
            shown.1 = Phase::Unpacking;
            hub.set(host, |st| st.phase = Phase::Unpacking);
        }
        Step::Unpack => {}
    };
    match ensure(&setup.layout, &setup.releases, &setup.version, &asset, &mut step, &|| hub.wanted()) {
        Ok(exe) => Ok((exe, setup.version.clone(), None)),
        Err(e) if !hub.wanted() => Err(e),
        Err(e) => match setup.layout.newest_installed(&asset) {
            // the hub that is here keeps working until the new one can be downloaded
            Some((v, exe)) => Ok((exe, v.clone(), Some(format!("Hub {} could not be downloaded, so hub {v} runs for now. {e}", setup.version)))),
            None => Err(e),
        },
    }
}

/// The keys of this user's homes, to tell its hubs from anything else on a port.
fn keys(setup: &Setup) -> Vec<(Owner, Vec<u8>)> {
    let mut out = Vec::new();
    if let Some(k) = home_key(&setup.layout.home()) {
        out.push((Owner::App, k));
    }
    if let Some(user) = setup.user_home.as_deref().filter(|h| *h != setup.layout.home()) {
        if let Some(k) = home_key(user) {
            out.push((Owner::User, k));
        }
    }
    out
}

/// One round: get the binary, pick the port, run (or adopt) the hub until it
/// stops or the switch goes off.
fn round(hub: &Hub, setup: &Setup, host: &dyn Host, backoff: &mut Backoff, avoid: &mut Vec<u16>) {
    let (saved_port, adopted) = host.saved();
    let home = setup.layout.home();
    let mode = if adopted {
        Mode::Adopted
    } else if home.join("config.json").is_file() {
        Mode::Own
    } else {
        Mode::Fresh
    };
    let preferred = saved_port.unwrap_or(DEFAULT_PORT);
    let keys = keys(setup);
    let refused = avoid.clone();
    let user_port = setup.user_home.as_deref().map(home_port);
    let on_port = |p: u16| if refused.contains(&p) { OnPort::Taken } else { trusted(probe(p, &keys), p, user_port) };
    let mut chosen = plan(preferred, mode, &mut |p| on_port(p));
    // The port this hub had is busy: most likely its own hub from a moment
    // ago, still stopping (it takes up to 10 seconds). Wait before moving.
    if mode == Mode::Own && !refused.contains(&preferred) && matches!(chosen, Plan::Start { moved_from: Some(_), .. } | Plan::Leftover { .. }) {
        hub.phase(host, Status { phase: Phase::Waiting, port: Some(preferred), note: Some(format!("Port {preferred} is busy, perhaps with the hub from before. Waiting a moment")), ..Default::default() });
        let until = Instant::now() + Duration::from_secs(15);
        while Instant::now() < until && hub.wanted() && on_port(preferred) != OnPort::Free {
            hub.sleep(Duration::from_secs(1), false);
        }
        if !hub.wanted() {
            return;
        }
        chosen = plan(preferred, mode, &mut |p| on_port(p));
    }
    match chosen {
        Plan::NoPort { from, to } => fail(hub, host, backoff, format!("Ports {from} to {to} are all in use. Close the program on port {from}, then try again")),
        Plan::Adopt { port } | Plan::Absent { port } => {
            host.remember(port, true);
            watch_external(hub, setup, host, port, Owner::User);
        }
        Plan::Leftover { port } => watch_external(hub, setup, host, port, Owner::App),
        Plan::Start { port, moved_from } => {
            // the binary only when the app runs its own hub: a hub it uses needs no download
            let (exe, version, mut note) = match binary(hub, setup, host) {
                Ok(found) => found,
                Err(_) if !hub.wanted() => return,
                Err(e) => return fail(hub, host, backoff, e),
            };
            if let Some(from) = moved_from {
                let moved = format!("Port {from} is in use by another program, so the hub uses port {port}");
                note = Some(match note {
                    Some(n) => format!("{} {n}", sentence(&moved)),
                    None => moved,
                });
            }
            if let Some(port) = run_own(hub, setup, host, backoff, &exe, &version, port, note) {
                avoid.push(port);
            }
        }
    }
}

/// A hub this app did not start: connect while it answers with its key, wait while it does not. Never stops it.
fn watch_external(hub: &Hub, setup: &Setup, host: &dyn Host, port: u16, owner: Owner) {
    let home = match owner {
        Owner::App => setup.layout.home(),
        Owner::User => setup.user_home.clone().unwrap_or_default(),
    };
    let base = local_base(port);
    let waiting = match owner {
        Owner::User => format!("The hub on port {port} was started outside the app (conclave serve) and is not running. Start it, or turn this off and on to run the app's own hub"),
        Owner::App => "The hub from before is still running".into(),
    };
    let mut connected = false;
    while hub.wanted() {
        // this user's own hub only on the port it is set up for (see `trusted`)
        let here = owner == Owner::App || home_port(&home) == port;
        let up = here && home_key(&home).is_some_and(|k| who_answers(&base, &[(owner, k)]).is_some());
        if up && !connected {
            hub.phase(host, Status { phase: Phase::Connecting, port: Some(port), external: true, ..Default::default() });
            let result = home_token(&home).ok_or_else(|| format!("No token in {}", home.join("config.json").display())).and_then(|t| host.connected(hub, &base, &t));
            match result {
                Ok(()) => {
                    connected = true;
                    hub.phase(host, Status { phase: Phase::Running, port: Some(port), external: true, ..Default::default() });
                }
                Err(e) => hub.phase(host, Status { phase: Phase::Waiting, port: Some(port), external: true, note: Some(format!("The app cannot connect to the hub on port {port}: {e}")), ..Default::default() }),
            }
        } else if !up && (connected || hub.status().phase != Phase::Waiting) {
            connected = false;
            hub.phase(host, Status { phase: Phase::Waiting, port: Some(port), external: true, note: Some(waiting.clone()), ..Default::default() });
            if owner == Owner::App {
                // it went away: the next round starts the app's own hub in its place
                return;
            }
        }
        hub.sleep(Duration::from_secs(5), true);
    }
}

/// The hub's stdout and stderr: hub.log, started over past 10 MB (one old copy kept).
/// This user's only: the folder 0700 and the file 0600, also when they were made
/// before. On Windows the app's local data folder is the user's own already.
fn private(path: &Path, dir: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(if dir { 0o700 } else { 0o600 }));
    }
    #[cfg(not(unix))]
    let _ = (path, dir);
}

fn open_log(file: &Path, version: &str, port: u16) -> Result<fs::File, String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot make {}: {e}", dir.display()))?;
        private(dir, true);
    }
    if fs::metadata(file).map(|m| m.len() > 10 * 1024 * 1024).unwrap_or(false) {
        let _ = fs::rename(file, file.with_extension("log.1"));
    }
    private(&file.with_extension("log.1"), false);
    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(file).map_err(|e| format!("Cannot open {}: {e}", file.display()))?;
    private(file, false);
    let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = writeln!(f, "{MARK}, version {version}, port {port}, unix time {at} ---");
    Ok(f)
}

/// The hub's arguments. Without `lan` it listens on 127.0.0.1 only: switching the
/// hub on must not open it to every network the computer joins (a cafe's Wi-Fi).
/// Phones then reach it through remote access (a tunnel connects on loopback).
pub fn serve_args(port: u16, lan: bool) -> Vec<String> {
    let mut args = vec!["serve".to_string(), "--port".to_string(), port.to_string()];
    if !lan {
        args.extend(["--host".to_string(), "127.0.0.1".to_string()]);
    }
    args
}

fn spawn(setup: &Setup, exe: &Path, version: &str, port: u16, lan: bool) -> Result<(Child, ChildStdin), String> {
    let home = setup.layout.home();
    fs::create_dir_all(&home).map_err(|e| format!("Cannot make {}: {e}", home.display()))?;
    #[cfg(unix)]
    {
        // config, keys and the database: this user only
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&home, fs::Permissions::from_mode(0o700));
    }
    let out = open_log(&setup.layout.log_file(), version, port)?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let vars: Vec<(String, String)> = std::env::vars().collect();
    let mut env = child_env(vars, std::env::var("APPDIR").ok().as_deref());
    let current = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v.clone()).unwrap_or_default();
    // asked once per run of the app: a restart after a crash should not wait for the shell again
    static LOGIN_PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    if let Some(path) = LOGIN_PATH.get_or_init(|| login_path(setup.home_dir.as_deref(), &current)) {
        env.retain(|(k, _)| !k.eq_ignore_ascii_case("PATH"));
        env.push(("PATH".into(), path.clone()));
    }
    let mut cmd = Command::new(exe);
    cmd.args(serve_args(port, lan))
        .env_clear()
        .envs(env)
        .env("CONCLAVE_HOME", &home)
        .env("CONCLAVE_DETACHED", "1")
        .env(STOP_ON_STDIN_END, "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(out)
        .stderr(err);
    if let Some(dir) = setup.home_dir.as_deref().filter(|d| d.is_dir()) {
        cmd.current_dir(dir);
    }
    no_window(&mut cmd);
    #[cfg(unix)]
    {
        // its own process group: Ctrl+C in a terminal that started the app is the app's to handle
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Cannot start {}: {e}", exe.display()))?;
    let stdin = child.stdin.take().ok_or("The hub has no stdin.")?;
    Ok((child, stdin))
}

fn wait_exit(child: &mut Child, d: Duration) -> Option<ExitStatus> {
    let until = Instant::now() + d;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if Instant::now() >= until {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Close stdin: the hub shuts down (it gives itself 10 seconds). Then SIGTERM, then kill.
fn stop_child(child: Child, stdin: ChildStdin) {
    stop_child_within(child, stdin, Duration::from_secs(12), Duration::from_secs(3));
}

fn stop_child_within(mut child: Child, stdin: ChildStdin, grace: Duration, term: Duration) {
    drop(stdin);
    if wait_exit(&mut child, grace).is_some() {
        return;
    }
    #[cfg(unix)]
    {
        // SAFETY: a plain signal to our own child, which has not been reaped yet.
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        if wait_exit(&mut child, term).is_some() {
            return;
        }
    }
    #[cfg(not(unix))]
    let _ = term;
    kill_tree(&mut child);
}

/// Kill a hub that does not stop, with what it started (CLIProxyAPI, a tunnel,
/// MCP servers, shells): left running they would hold their ports and files
/// against the next hub. On Unix the hub leads its own process group (`spawn`);
/// on Windows taskkill walks its tree. Only while the hub is alive and not yet
/// reaped, so its id still names it.
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        // SAFETY: a signal to the process group our unreaped child leads (process_group(0) in spawn).
        unsafe {
            libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        // the system's own, as for tar: not whatever a PATH names first
        let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let mut cmd = Command::new(root.join("System32").join("taskkill.exe"));
        cmd.args(["/PID", &child.id().to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        no_window(&mut cmd);
        let _ = cmd.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Run the app's own hub on `port` until the switch goes off or it stops on
/// its own. Returns the port when the hub could not bind it.
#[allow(clippy::too_many_arguments)]
fn run_own(hub: &Hub, setup: &Setup, host: &dyn Host, backoff: &mut Backoff, exe: &Path, version: &str, port: u16, note: Option<String>) -> Option<u16> {
    let started = Instant::now();
    let (mut child, stdin) = match spawn(setup, exe, version, port, host.lan()) {
        Ok(c) => c,
        Err(e) => {
            fail(hub, host, backoff, e);
            return None;
        }
    };
    let pid = Some(child.id());
    let version = Some(version.to_string());
    let base = local_base(port);
    let home = setup.layout.home();
    let log = setup.layout.log_file();
    let at = |phase| Status { phase, port: Some(port), pid, version: version.clone(), note: note.clone(), ..Default::default() };
    hub.phase(host, at(Phase::Starting));

    // up: it answers on the port, signing with this home's key
    let stopped = loop {
        if !hub.wanted() {
            hub.phase(host, at(Phase::Stopping));
            stop_child(child, stdin);
            return None;
        }
        if let Ok(Some(status)) = child.try_wait() {
            break exit_words(&status);
        }
        if started.elapsed() > Duration::from_secs(120) {
            kill_tree(&mut child);
            break "It did not answer in 2 minutes".into();
        }
        if home_key(&home).is_some_and(|k| who_answers(&base, &[(Owner::App, k)]).is_some()) {
            break String::new();
        }
        hub.sleep(Duration::from_millis(300), false);
    };
    if !stopped.is_empty() {
        let error = last_error(&tail(&log)).unwrap_or(stopped);
        // a port that looked free, but the hub could not bind it: the next round picks another
        let refused = is_bind_error(&error).then_some(port);
        after_stop(hub, host, backoff, started.elapsed(), error);
        return refused;
    }

    hub.phase(host, at(Phase::Connecting));
    host.remember(port, false);
    let connect = home_token(&home).ok_or_else(|| format!("The hub wrote no token into {}", home.join("config.json").display())).and_then(|t| host.connected(hub, &base, &t));
    let mut running = at(Phase::Running);
    if let Err(e) = connect {
        running.note = Some(format!("The hub runs, but the app cannot connect to it: {e}"));
    }
    hub.phase(host, running);
    if let Some(v) = &version {
        if setup.bin.is_none() {
            setup.layout.prune(v);
        }
    }

    loop {
        if !hub.wanted() {
            hub.phase(host, at(Phase::Stopping));
            stop_child(child, stdin);
            return None;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                drop(stdin);
                let error = last_error(&tail(&log)).unwrap_or_else(|| exit_words(&status));
                after_stop(hub, host, backoff, started.elapsed(), error);
                return None;
            }
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                after_stop(hub, host, backoff, started.elapsed(), e.to_string());
                return None;
            }
        }
        hub.sleep(Duration::from_millis(500), false);
    }
}

/// The hub stopped on its own: start again after the backoff wait, or give up.
fn after_stop(hub: &Hub, host: &dyn Host, backoff: &mut Backoff, ran: Duration, error: String) {
    match backoff.next(ran) {
        Some(wait) => {
            hub.phase(host, Status { phase: Phase::Retrying, error: Some(error), retry_in: Some(wait.as_secs()), ..Default::default() });
            hub.sleep(wait, true);
        }
        None => fail(hub, host, backoff, format!("The hub keeps stopping. Its last error: {}", sentence(&error))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("conclave-desktop-local-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn picks_the_release_file_for_each_system() {
        let a = asset_for("linux", "x86_64", false).unwrap();
        assert_eq!((a.name.as_str(), a.file.as_str()), ("conclave-linux-x64", "conclave-linux-x64.tar.gz"));
        assert_eq!(asset_for("linux", "x86_64", true).unwrap().file, "conclave-linux-x64-baseline.tar.gz");
        assert_eq!(asset_for("linux", "aarch64", false).unwrap().file, "conclave-linux-arm64.tar.gz");
        assert_eq!(asset_for("macos", "aarch64", false).unwrap().file, "conclave-darwin-arm64.tar.gz");
        assert_eq!(asset_for("macos", "x86_64", true).unwrap().file, "conclave-darwin-x64.tar.gz");
        let w = asset_for("windows", "x86_64", false).unwrap();
        assert_eq!(w.file, "conclave-windows-x64.zip");
        assert!(w.is_zip() && !a.is_zip());
        // no release builds these
        assert!(asset_for("windows", "aarch64", false).is_none());
        assert!(asset_for("freebsd", "x86_64", false).is_none());
        assert!(this_asset().is_ok());
    }

    #[test]
    fn builds_release_urls_with_one_v() {
        assert_eq!(release_url(RELEASES, "0.3.0", "conclave-linux-x64.tar.gz"), "https://github.com/default-cybe/conclave/releases/download/v0.3.0/conclave-linux-x64.tar.gz");
        assert_eq!(release_url("http://127.0.0.1:9/r/", "v1.2.3-rc.1", "x.zip"), "http://127.0.0.1:9/r/v1.2.3-rc.1/x.zip");
    }

    #[test]
    fn checks_the_sha256() {
        let sum = "ad56df1c203d553c8408edb92287abc32f674a6b664cd89682dba52de5386107";
        assert_eq!(parse_sha256(&format!("{sum}  conclave-linux-x64.tar.gz\n")).as_deref(), Some(sum));
        assert_eq!(parse_sha256(&sum.to_uppercase()).as_deref(), Some(sum));
        assert!(parse_sha256("").is_none());
        assert!(parse_sha256("not-a-hash  file").is_none());
        assert!(parse_sha256(&format!("{}  file", &sum[..63])).is_none());

        // the SHA-256 of "abc" (FIPS 180-2)
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(sha256_hex(&b"abc"[..]).unwrap(), abc);
        let dir = tmp("sha");
        let file = dir.join("a.tar.gz");
        fs::write(&file, b"abc").unwrap();
        assert!(check_sha256(&file, abc, "a.tar.gz").is_ok());
        assert!(check_sha256(&file, &abc.to_uppercase(), "a.tar.gz").is_ok());
        let err = check_sha256(&file, sum, "a.tar.gz").unwrap_err();
        assert!(err.contains("damaged") && err.contains("a.tar.gz.sha256"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    fn table(ports: &[(u16, OnPort)]) -> impl FnMut(u16) -> OnPort + '_ {
        move |p| ports.iter().find(|(q, _)| *q == p).map(|(_, o)| *o).unwrap_or(OnPort::Free)
    }

    #[test]
    fn chooses_a_port() {
        // free: the port it wants
        assert_eq!(plan(7717, Mode::Fresh, &mut table(&[])), Plan::Start { port: 7717, moved_from: None });
        assert_eq!(plan(7718, Mode::Own, &mut table(&[])), Plan::Start { port: 7718, moved_from: None });
        // taken by another program or another user's hub: the next free one
        let busy = [(7717, OnPort::Taken), (7718, OnPort::Taken)];
        assert_eq!(plan(7717, Mode::Fresh, &mut table(&busy)), Plan::Start { port: 7719, moved_from: Some(7717) });
        // a hub of this user on the next port is not free either
        let mixed = [(7717, OnPort::Taken), (7718, OnPort::Ours(Owner::User)), (7719, OnPort::Ours(Owner::App))];
        assert_eq!(plan(7717, Mode::Own, &mut table(&mixed)), Plan::Start { port: 7720, moved_from: Some(7717) });
        // all taken
        let mut all = |_| OnPort::Taken;
        assert_eq!(plan(7717, Mode::Fresh, &mut all), Plan::NoPort { from: 7717, to: 7737 });
        // the end of the port range
        assert_eq!(plan(65535, Mode::Fresh, &mut all), Plan::NoPort { from: 65535, to: 65535 });
    }

    #[test]
    fn adopts_this_users_hub_only_the_first_time() {
        let user = [(7717, OnPort::Ours(Owner::User))];
        // the first time, `conclave serve` of this user is the hub to use
        assert_eq!(plan(7717, Mode::Fresh, &mut table(&user)), Plan::Adopt { port: 7717 });
        // once the app's own hub has data, it keeps it and moves aside
        assert_eq!(plan(7717, Mode::Own, &mut table(&user)), Plan::Start { port: 7718, moved_from: Some(7717) });
        // an adopted hub stays adopted: used while it runs, waited for when it does not
        assert_eq!(plan(7717, Mode::Adopted, &mut table(&user)), Plan::Adopt { port: 7717 });
        assert_eq!(plan(7717, Mode::Adopted, &mut table(&[])), Plan::Absent { port: 7717 });
        assert_eq!(plan(7717, Mode::Adopted, &mut table(&[(7717, OnPort::Taken)])), Plan::Absent { port: 7717 });
        // the app's own hub from before still answers: wait for it, never start a second one there
        let own = [(7717, OnPort::Ours(Owner::App))];
        assert_eq!(plan(7717, Mode::Own, &mut table(&own)), Plan::Leftover { port: 7717 });
        assert_eq!(plan(7717, Mode::Fresh, &mut table(&own)), Plan::Leftover { port: 7717 });
    }

    #[test]
    fn waits_longer_after_each_quick_stop_then_gives_up() {
        let mut b = Backoff::default();
        let quick = Duration::from_secs(3);
        let waits: Vec<Option<u64>> = (0..7).map(|_| b.next(quick).map(|d| d.as_secs())).collect();
        assert_eq!(waits, vec![Some(1), Some(2), Some(4), Some(8), Some(16), Some(32), None]);
        // a run of a minute or more was healthy: the count starts over
        let mut b = Backoff::default();
        b.next(quick);
        b.next(quick);
        assert_eq!(b.next(Backoff::HEALTHY).map(|d| d.as_secs()), Some(1));
        assert_eq!(b.next(quick).map(|d| d.as_secs()), Some(2));
        b.reset();
        assert_eq!(b.next(quick).map(|d| d.as_secs()), Some(1));
    }

    #[test]
    fn finds_the_last_error_of_the_last_start() {
        let log = format!(
            "{MARK}, version 0.3.0, port 7717 ---\nError: an old error from the first run\n{MARK}, version 0.3.0, port 7717 ---\n\u{1b}[31mError: \u{1b}[0mCould not listen on http://127.0.0.1:7717: address in use\n"
        );
        assert_eq!(last_error(&log).as_deref(), Some("Could not listen on http://127.0.0.1:7717: address in use"));
        // a crash with a stack: the error line, not a frame
        let crash = format!("{MARK} ---\nhub started\nTypeError: undefined is not an object\n    at foo (/$bunfs/root/conclave:1:2)\n    at bar (/$bunfs/root/conclave:3:4)\n");
        assert_eq!(last_error(&crash).as_deref(), Some("TypeError: undefined is not an object"));
        // the hub's own ERROR line, without its time and level; INFO and WARN lines are not errors
        let logged = format!(
            "{MARK} ---\n2026-10-21T04:37:19.210Z ERROR [db] database disk image is malformed\n2026-10-21T04:37:19.300Z INFO  [device] device connected deviceId=dev_1\n2026-10-21T04:37:19.400Z WARN  [remote] tunnel error, retrying\n"
        );
        assert_eq!(last_error(&logged).as_deref(), Some("[db] database disk image is malformed"));
        // killed with nothing said: no error to show (the caller says how it ended)
        assert_eq!(last_error(&format!("{MARK} ---\n2026-10-21T04:37:19.210Z INFO  [device] device connected\n")), None);
        assert_eq!(last_error(&format!("{MARK} ---\n")), None);
        // a log from before the marks counts as one run
        assert_eq!(last_error("Error: disk full\n").as_deref(), Some("disk full"));
        let long = format!("Error: {}", "x".repeat(400));
        assert_eq!(last_error(&long).unwrap().chars().count(), 303);
    }

    #[cfg(unix)]
    #[test]
    fn says_how_a_process_ended() {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(exit_words(&ExitStatus::from_raw(9)), "It was stopped by signal 9 (SIGKILL)");
        assert_eq!(exit_words(&ExitStatus::from_raw(1 << 8)), "It exited with code 1");
    }

    #[test]
    fn reads_the_owner_token_and_the_key_of_a_home() {
        let home = tmp("home");
        assert!(home_token(&home).is_none() && home_key(&home).is_none());
        fs::write(home.join("config.json"), r#"{ "server": { "token": "owner-secret" }, "defaultModel": "x" }"#).unwrap();
        assert_eq!(home_token(&home).as_deref(), Some("owner-secret"));
        fs::write(home.join("config.json"), r#"{ "server": { "port": 7717 } }"#).unwrap();
        assert!(home_token(&home).is_none());
        fs::write(home.join("hub-key.pem"), FIXTURE_PEM).unwrap();
        assert_eq!(home_key(&home), Some(b64(FIXTURE_PUBLIC)));
        fs::write(home.join("hub-key.pem"), "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n").unwrap();
        assert!(home_key(&home).is_none());
        let _ = fs::remove_dir_all(&home);
    }

    // made by node:crypto the way the hub makes its key (packages/server/src/identity.ts)
    const FIXTURE_PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEILgAzDM9Dn/DtYMcCAMnQxFPwoIIwRWX1H4WUH8h4xml\n-----END PRIVATE KEY-----\n";
    const FIXTURE_PUBLIC: &str = "julIIIdU_MQWrCl_L17QIz9HxrWRtvpDhiR4bquAYJM";
    const FIXTURE_NONCE: &str = "abcdefghijklmnopqrstuvwx";
    const FIXTURE_SIGNATURE: &str = "8uWmFeNOURG0Sd0-GniqesiVTrJltwjJAFEsxXHzwyvpa9R6TwrmMB_JmFpYR7VD3jvRFv0hPAdpDrLO-5TXAg";

    fn b64(s: &str) -> Vec<u8> {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).unwrap()
    }

    #[test]
    fn a_hub_proves_it_holds_the_homes_key() {
        let key = public_key_from_pem(FIXTURE_PEM).unwrap();
        let reply = serde_json::json!({ "publicKey": FIXTURE_PUBLIC, "fingerprint": "x", "signature": FIXTURE_SIGNATURE });
        assert!(proves(&key, FIXTURE_NONCE, &reply));
        // another nonce (a replayed answer), another key, a broken or missing signature: no
        assert!(!proves(&key, "abcdefghijklmnopqrstuvwy", &reply));
        let other = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
        let other = ring::signature::Ed25519KeyPair::from_pkcs8(other.as_ref()).unwrap();
        let other_public = ring::signature::KeyPair::public_key(&other).as_ref().to_vec();
        assert!(!proves(&other_public, FIXTURE_NONCE, &reply));
        // a stranger that names our key but signs with its own
        let forged = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(other.sign(format!("{IDENTITY_PREFIX}{FIXTURE_NONCE}").as_bytes()).as_ref());
        assert!(!proves(&key, FIXTURE_NONCE, &serde_json::json!({ "publicKey": FIXTURE_PUBLIC, "signature": forged })));
        assert!(!proves(&key, FIXTURE_NONCE, &serde_json::json!({ "publicKey": FIXTURE_PUBLIC })));
        assert!(!proves(&key, FIXTURE_NONCE, &serde_json::json!({ "ok": true, "version": "0.3.0" })));
        // nonces are fresh and fit the hub's rule (16 to 128 base64url characters)
        let (a, b) = (new_nonce(), new_nonce());
        assert_ne!(a, b);
        assert!(a.len() >= 16 && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn tells_a_free_port_from_a_taken_one() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_free(port));
        // nothing there signs with a key of ours: taken, and no token is sent to it
        assert_eq!(probe(port, &[(Owner::App, b64(FIXTURE_PUBLIC))]), OnPort::Taken);
        drop(listener);
        assert!(port_free(port));
        // a hub that could not bind its port: the next round avoids that port
        assert!(is_bind_error("Could not listen on http://127.0.0.1:7717: Failed to start server. Is port 7717 in use?"));
        assert!(is_bind_error("listen EADDRINUSE: address already in use 0.0.0.0:7717"));
        assert!(!is_bind_error("[db] database disk image is malformed"));
    }

    /// A stand-in for this user's `conclave serve`: answers /api/identity, signing with the fixture key.
    fn identity_server() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let body: String = FIXTURE_PEM.lines().filter(|l| !l.starts_with("-----")).collect();
            let der = base64::engine::general_purpose::STANDARD.decode(body).unwrap();
            let pair = ring::signature::Ed25519KeyPair::from_pkcs8_maybe_unchecked(&der).unwrap();
            for mut stream in listener.incoming().flatten() {
                let req = read_request(&mut stream);
                let nonce = req.split("nonce=").nth(1).and_then(|r| r.split([' ', '&']).next()).unwrap_or("").to_string();
                let sig = pair.sign(format!("{IDENTITY_PREFIX}{nonce}").as_bytes());
                let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
                let reply = serde_json::json!({ "publicKey": b64.encode(ring::signature::KeyPair::public_key(&pair).as_ref()), "signature": b64.encode(sig.as_ref()) }).to_string();
                let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len());
            }
        });
        port
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut req = Vec::new();
        let mut buf = [0u8; 1024];
        while !req.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => req.extend_from_slice(&buf[..n]),
            }
        }
        String::from_utf8_lossy(&req).into_owned()
    }

    /// Another user's program on a port that passes every request on to `to`.
    fn relay(to: u16) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let req = read_request(&mut stream);
                let mut up = TcpStream::connect(("127.0.0.1", to)).unwrap();
                up.write_all(req.as_bytes()).unwrap();
                let mut reply = Vec::new();
                let _ = up.read_to_end(&mut reply);
                let _ = stream.write_all(&reply);
            }
        });
        port
    }

    #[test]
    fn a_program_that_passes_the_nonce_on_is_not_this_users_hub() {
        let key = public_key_from_pem(FIXTURE_PEM).unwrap();
        let theirs = identity_server();
        let middle = relay(theirs);
        // the signature checks out through the relay: proof that someone holds the key, not who listens here
        assert_eq!(probe(middle, &[(Owner::User, key.clone())]), OnPort::Ours(Owner::User));
        // so this user's hub counts only on the port it is set up for, where nobody else can listen
        assert_eq!(trusted(probe(middle, &[(Owner::User, key.clone())]), middle, Some(theirs)), OnPort::Taken);
        assert_eq!(trusted(probe(theirs, &[(Owner::User, key.clone())]), theirs, Some(theirs)), OnPort::Ours(Owner::User));
        // the first start does not adopt the relay; it starts the app's own hub next to it
        let mut on = |p: u16| trusted(probe(p, &[(Owner::User, key.clone())]), p, Some(theirs));
        assert!(matches!(plan(middle, Mode::Fresh, &mut on), Plan::Start { moved_from: Some(m), .. } if m == middle));
        // the app's own home is not judged by port: only the app runs a hub with it
        assert_eq!(trusted(OnPort::Ours(Owner::App), 1, Some(2)), OnPort::Ours(Owner::App));
        assert_eq!(trusted(OnPort::Free, 1, None), OnPort::Free);
    }

    #[test]
    fn reads_the_port_a_home_is_set_up_for() {
        let home = tmp("home-port");
        assert_eq!(home_port(&home), DEFAULT_PORT);
        fs::write(home.join("config.json"), r#"{ "server": { "port": 7800, "token": "t" } }"#).unwrap();
        assert_eq!(home_port(&home), 7800);
        fs::write(home.join("config.json"), r#"{ "server": { "port": 99999 } }"#).unwrap();
        assert_eq!(home_port(&home), DEFAULT_PORT);
        fs::write(home.join("config.json"), "not json").unwrap();
        assert_eq!(home_port(&home), DEFAULT_PORT);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn listens_on_this_computer_only_unless_phones_may_connect() {
        assert_eq!(serve_args(7717, false), ["serve", "--port", "7717", "--host", "127.0.0.1"]);
        assert_eq!(serve_args(7718, true), ["serve", "--port", "7718"]);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_the_hub_log_this_users_only() {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp("log-mode");
        let logs = home.join("logs");
        fs::create_dir_all(&logs).unwrap();
        fs::set_permissions(&logs, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(logs.join("hub.log"), "from before\n").unwrap();
        fs::set_permissions(logs.join("hub.log"), fs::Permissions::from_mode(0o644)).unwrap();
        drop(open_log(&logs.join("hub.log"), "0.4.0", 7717).unwrap());
        assert_eq!(fs::metadata(&logs).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(logs.join("hub.log")).unwrap().permissions().mode() & 0o777, 0o600);
        let text = fs::read_to_string(logs.join("hub.log")).unwrap();
        assert!(text.starts_with("from before\n") && text.contains(MARK));
        // a new one is made that way too
        let fresh = home.join("other").join("hub.log");
        drop(open_log(&fresh, "0.4.0", 7717).unwrap());
        assert_eq!(fs::metadata(&fresh).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(fresh.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = fs::remove_dir_all(&home);
    }

    /// Gone, or a zombie waiting for init: no longer running.
    #[cfg(target_os = "linux")]
    fn running(pid: i32) -> bool {
        fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.rsplit(')').next().is_some_and(|rest| !rest.trim_start().starts_with('Z')))
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_hub_that_will_not_stop_is_killed_with_what_it_started() {
        use std::io::BufRead;
        use std::os::unix::process::CommandExt;
        // a "hub" that ignores its stdin and SIGTERM, and has started a program of its own
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "trap '' TERM; sleep 60 & echo $!; wait"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        cmd.process_group(0);
        let mut child = cmd.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let started: i32 = line.trim().parse().unwrap();
        let hub = child.id() as i32;
        assert!(running(started) && running(hub));
        stop_child_within(child, stdin, Duration::from_millis(200), Duration::from_millis(200));
        let until = Instant::now() + Duration::from_secs(5);
        while running(started) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!running(hub), "the hub was killed");
        assert!(!running(started), "what it started is gone too, not left holding its ports");
    }

    #[test]
    fn cleans_the_environment_for_the_hub() {
        let vars = |list: &[(&str, &str)]| list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let env = child_env(
            vars(&[("CONCLAVE_TOKEN", "t"), ("conclave_port", "1"), ("CONCLAVE_HOME", "/x"), ("HOME", "/home/a"), ("CONCLAVE_MODEL", "m"), ("PATH", "/usr/bin")]),
            None,
        );
        assert_eq!(env, vars(&[("HOME", "/home/a"), ("CONCLAVE_MODEL", "m"), ("PATH", "/usr/bin")]));
        // an AppImage: its mount leaves every list, and its own variables go
        let app = "/tmp/.mount_ConclaXYZ";
        let env = child_env(
            vars(&[
                ("APPDIR", app),
                ("APPIMAGE", "/home/a/Conclave.AppImage"),
                ("PATH", "/tmp/.mount_ConclaXYZ/usr/bin:/usr/local/bin:/usr/bin"),
                ("LD_LIBRARY_PATH", "/tmp/.mount_ConclaXYZ/usr/lib"),
                ("XDG_DATA_DIRS", "/tmp/.mount_ConclaXYZ/usr/share:/usr/share"),
                ("GDK_PIXBUF_MODULE_FILE", "/tmp/.mount_ConclaXYZ/usr/lib/loaders.cache"),
                ("LANG", "en_US.UTF-8"),
            ]),
            Some(app),
        );
        assert_eq!(env, vars(&[("PATH", "/usr/local/bin:/usr/bin"), ("XDG_DATA_DIRS", "/usr/share"), ("LANG", "en_US.UTF-8")]));
    }

    #[cfg(unix)]
    #[test]
    fn reads_the_path_a_shell_ends_up_with() {
        // an interactive sh with this environment and an empty home: the PATH it was given
        let home = tmp("shell-home");
        let env = vec![("PATH".to_string(), "/usr/bin:/bin:/opt/x/bin".to_string()), ("HOME".to_string(), home.display().to_string())];
        assert_eq!(shell_path("/bin/sh", false, Some(env)).as_deref(), Some("/usr/bin:/bin:/opt/x/bin"));
        assert_eq!(shell_path("/no/such/shell", true, None), None);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn merges_the_login_path() {
        assert_eq!(parse_marked_path("motd\n__CONCLAVE_PATH__/a:/b__CONCLAVE_PATH__").as_deref(), Some("/a:/b"));
        assert!(parse_marked_path("no marks").is_none());
        assert!(parse_marked_path("__CONCLAVE_PATH____CONCLAVE_PATH__").is_none());
        let exists = |d: &str| d != "/missing";
        let merged = merge_paths(&[Some("/opt/homebrew/bin:/usr/bin"), None, Some("/usr/bin:/bin:")], &["/bin".into(), "/missing".into(), "/home/a/.local/bin".into()], &exists);
        assert_eq!(merged, "/opt/homebrew/bin:/usr/bin:/bin:/home/a/.local/bin");
    }

    #[test]
    fn downloads_skip_the_proxy_for_this_computer_and_no_proxy() {
        assert!(uses_proxy("github.com", ""));
        assert!(!uses_proxy("127.0.0.1", ""));
        assert!(!uses_proxy("[::1]", ""));
        assert!(!uses_proxy("localhost", ""));
        assert!(!uses_proxy("mirror.corp.example", "localhost, .corp.example"));
        assert!(!uses_proxy("corp.example", "*.corp.example"));
        assert!(uses_proxy("github.com", "corp.example,hub.local"));
        assert!(!uses_proxy("github.com", "*"));
        assert!(uses_proxy("notcorp.example", "corp.example"));
    }

    #[test]
    fn sorts_versions_by_number() {
        let mut v = vec!["0.10.0", "0.9.2", "0.9.10", "1.0.0-rc.1"];
        v.sort_by_key(|s| version_key(s));
        assert_eq!(v, vec!["0.9.2", "0.9.10", "0.10.0", "1.0.0-rc.1"]);
    }

    #[test]
    fn finds_and_prunes_installed_versions() {
        let layout = Layout { data: tmp("layout") };
        let asset = asset_for("linux", "x86_64", false).unwrap();
        let put = |v: &str, complete: bool| {
            let dir = layout.version_dir(v);
            fs::create_dir_all(dir.join(&asset.name)).unwrap();
            fs::write(dir.join(&asset.name).join(EXE), b"bin").unwrap();
            if complete {
                fs::write(dir.join(COMPLETE), b"sum").unwrap();
            }
        };
        assert!(layout.installed("0.3.0", &asset).is_none());
        put("0.2.0", true);
        put("0.10.0", true);
        put("0.11.0", false);
        assert!(layout.installed("0.2.0", &asset).is_some());
        // an unpack that did not finish does not count
        assert!(layout.installed("0.11.0", &asset).is_none());
        assert_eq!(layout.newest_installed(&asset).map(|(v, _)| v).as_deref(), Some("0.10.0"));
        layout.prune("0.10.0");
        assert!(layout.installed("0.10.0", &asset).is_some());
        assert!(layout.installed("0.2.0", &asset).is_none());
        assert!(!layout.version_dir("0.11.0").exists());
        let _ = fs::remove_dir_all(&layout.data);
    }

    #[test]
    fn says_the_state_in_words() {
        let s = |phase| Status { phase, port: Some(7718), ..Default::default() };
        assert_eq!(words(&s(Phase::Running)), "Running at http://127.0.0.1:7718.");
        assert_eq!(words(&Status { external: true, ..s(Phase::Running) }), "Running at http://127.0.0.1:7718. The app did not start this hub, so it does not stop it.");
        assert_eq!(words(&Status { done: 12_000_000, total: Some(40_216_150), ..s(Phase::Getting) }), "Downloading the hub: 12 of 40 MB.");
        assert_eq!(words(&Status { done: 1_500_000, ..s(Phase::Getting) }), "Downloading the hub: 1.5 MB.");
        assert_eq!(
            words(&Status { error: Some("Could not listen".into()), retry_in: Some(8), ..s(Phase::Retrying) }),
            "The hub stopped: Could not listen. Starting it again in 8 seconds."
        );
        assert_eq!(words(&Status { error: Some("Ports 7717 to 7737 are all in use".into()), ..s(Phase::Failed) }), "Ports 7717 to 7737 are all in use.");
        assert_eq!(
            words(&Status { note: Some("Port 7717 is in use by another program, so the hub uses port 7718".into()), ..s(Phase::Running) }),
            "Running at http://127.0.0.1:7718. Port 7717 is in use by another program, so the hub uses port 7718."
        );
        assert_eq!(words(&Status { note: Some("Port 7717 is busy. Waiting a moment".into()), ..s(Phase::Waiting) }), "Port 7717 is busy. Waiting a moment.");
        assert_eq!(words(&s(Phase::Waiting)), "Waiting for the hub.");
        assert_eq!(words(&Status { note: Some("moved".into()), ..s(Phase::Stopping) }), "Stopping the hub.");
        for phase in [Phase::Off, Phase::Getting, Phase::Unpacking, Phase::Starting, Phase::Connecting, Phase::Running, Phase::Waiting, Phase::Retrying, Phase::Failed, Phase::Stopping] {
            let w = words(&s(phase));
            assert!(!w.contains('\u{2013}') && !w.contains('\u{2014}'), "{w}");
            let t = tray_line(true, &s(phase), None);
            assert!(t.starts_with("Hub on this computer: ") && !t.contains('\u{2014}'), "{t}");
        }
        assert_eq!(tray_line(true, &s(Phase::Running), None), "Hub on this computer: running on port 7718");
        assert_eq!(tray_line(true, &Status { done: 10, total: Some(40), ..s(Phase::Getting) }, None), "Hub on this computer: downloading, 25%");
        assert_eq!(tray_line(false, &s(Phase::Off), Some("box.example.com")), "Hub: box.example.com");
        assert_eq!(tray_line(false, &s(Phase::Off), None), "Hub: not set up");
    }

    /// A host that records what the manager did.
    #[derive(Default)]
    struct Recorder {
        port: Mutex<(Option<u16>, bool)>,
        tokens: Mutex<Vec<(String, String)>>,
        phases: Mutex<Vec<Phase>>,
    }

    impl Host for Recorder {
        fn saved(&self) -> (Option<u16>, bool) {
            *self.port.lock().unwrap()
        }
        fn remember(&self, port: u16, adopted: bool) {
            *self.port.lock().unwrap() = (Some(port), adopted);
        }
        fn connected(&self, _hub: &Hub, base: &Url, token: &str) -> Result<(), String> {
            crate::hub::check_token(base, token)?;
            self.tokens.lock().unwrap().push((base.to_string(), token.to_string()));
            Ok(())
        }
        fn changed(&self, status: &Status) {
            let mut p = self.phases.lock().unwrap();
            if p.last() != Some(&status.phase) {
                p.push(status.phase);
            }
        }
    }

    #[test]
    fn a_missing_binary_fails_in_words_and_off_ends_it() {
        let data = tmp("missing");
        let setup = Setup {
            layout: Layout { data: data.clone() },
            version: "0.0.0".into(),
            releases: "http://127.0.0.1:9".into(),
            bin: Some(data.join("no-such-conclave")),
            user_home: None,
            home_dir: None,
        };
        let hub = Hub::default();
        let host = Arc::new(Recorder::default());
        hub.start(setup, host.clone());
        let until = Instant::now() + Duration::from_secs(5);
        while hub.status().phase != Phase::Failed && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        let s = hub.status();
        assert_eq!(s.phase, Phase::Failed);
        assert!(words(&s).contains("CONCLAVE_HUB_BIN names"), "{}", words(&s));
        assert!(hub.stop(Duration::from_secs(5)));
        assert!(!hub.active());
        assert_eq!(hub.status().phase, Phase::Off);
        let _ = fs::remove_dir_all(&data);
    }

    #[cfg(unix)]
    #[test]
    fn downloads_checks_and_unpacks_a_release() {
        let data = tmp("install");
        let asset = asset_for("linux", "x86_64", false).unwrap();
        // a release archive: conclave-linux-x64/conclave and web/
        let src = data.join("src");
        fs::create_dir_all(src.join(&asset.name).join("web")).unwrap();
        fs::write(src.join(&asset.name).join("conclave"), b"#!/bin/sh\necho 0.3.0\n").unwrap();
        fs::write(src.join(&asset.name).join("web").join("index.html"), b"<!doctype html>").unwrap();
        let archive = data.join(&asset.file);
        assert!(Command::new("tar").arg("-czf").arg(&archive).arg("-C").arg(&src).arg(&asset.name).status().unwrap().success());
        let bytes = fs::read(&archive).unwrap();
        let sum = sha256_hex(&bytes[..]).unwrap();
        let layout = Layout { data: data.join("app") };

        // a .sha256 that does not match: nothing is installed
        let (base, _h) = super::tests_support_serve(vec![
            (format!("/v0.3.0/{}", asset.file), bytes.clone()),
            (format!("/v0.3.0/{}.sha256", asset.file), format!("{}  {}\n", "0".repeat(64), asset.file).into_bytes()),
        ]);
        let err = install(&layout, &base, "0.3.0", &asset, &mut |_| {}, &|| true).unwrap_err();
        assert!(err.contains("damaged"), "{err}");
        assert!(layout.installed("0.3.0", &asset).is_none());
        assert!(fs::read_dir(layout.bins()).unwrap().next().is_none(), "nothing is left behind");

        // a version the release does not have
        let (base, _h) = super::tests_support_serve(vec![]);
        let err = install(&layout, &base, "0.4.0", &asset, &mut |_| {}, &|| true).unwrap_err();
        assert!(err.contains("not in the release") && err.contains("v0.4.0/conclave-linux-x64.tar.gz"), "{err}");

        // the real thing, with progress
        let (base, _h) = super::tests_support_serve(vec![(format!("/v0.3.0/{}", asset.file), bytes.clone()), (format!("/v0.3.0/{}.sha256", asset.file), format!("{sum}  {}\n", asset.file).into_bytes())]);
        let mut steps = Vec::new();
        let exe = install(&layout, &base, "0.3.0", &asset, &mut |s| steps.push(s), &|| true).unwrap();
        assert_eq!(layout.installed("0.3.0", &asset).as_deref(), Some(exe.as_path()));
        assert!(exe.parent().unwrap().join("web").join("index.html").is_file(), "web/ stays next to the binary");
        assert_eq!(steps.first(), Some(&Step::Download { done: 0, total: Some(bytes.len() as u64) }));
        assert!(steps.contains(&Step::Download { done: bytes.len() as u64, total: Some(bytes.len() as u64) }));
        assert_eq!(steps.last(), Some(&Step::Unpack));
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o755);
        }
        let _ = fs::remove_dir_all(&data);
    }
}

/// The real hub, headless: `CONCLAVE_TEST_HUB=<release archive dir> CONCLAVE_TEST_DAEMON=<conclave-daemon>
/// cargo test real_hub -- --ignored --nocapture`. The archive dir holds
/// conclave-linux-x64.tar.gz and its .sha256, served as a release; the run
/// downloads it, starts the hub, connects with the owner token, pairs the
/// daemon, kills the hub and watches it come back, then stops it.
#[cfg(all(test, target_os = "linux"))]
mod real {
    use super::*;

    struct TestHost {
        port: Mutex<(Option<u16>, bool)>,
        token: Mutex<Option<String>>,
        daemon: Option<PathBuf>,
        conclave_home: PathBuf,
    }

    impl Host for TestHost {
        fn saved(&self) -> (Option<u16>, bool) {
            *self.port.lock().unwrap()
        }
        fn remember(&self, port: u16, adopted: bool) {
            *self.port.lock().unwrap() = (Some(port), adopted);
        }
        fn connected(&self, hub: &Hub, base: &Url, token: &str) -> Result<(), String> {
            crate::hub::check_token(base, token)?;
            *self.token.lock().unwrap() = Some(token.to_string());
            if let Some(daemon) = &self.daemon {
                // the device program pairs with the app's own (owner) token, as computer::pair does
                let out = Command::new(daemon)
                    .args(["pair", "--hub", &crate::hub::display(base.as_str()), "--app-token-stdin", "--json"])
                    .env("CONCLAVE_HOME", &self.conclave_home)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .and_then(|mut c| {
                        c.stdin.take().unwrap().write_all(format!("{token}\n").as_bytes())?;
                        c.wait_with_output()
                    })
                    .map_err(|e| e.to_string())?;
                eprintln!("daemon pair: {} {}", String::from_utf8_lossy(&out.stdout).trim(), String::from_utf8_lossy(&out.stderr).trim());
                if !out.status.success() {
                    hub.set_computer_error(Some("pairing failed".into()));
                }
            }
            Ok(())
        }
        fn changed(&self, status: &Status) {
            eprintln!("  [{}] {}", serde_json::to_string(&status.phase).unwrap(), words(status));
        }
    }

    fn wait_for(hub: &Hub, what: &str, secs: u64, ok: impl Fn(&Status) -> bool) -> Status {
        let until = Instant::now() + Duration::from_secs(secs);
        loop {
            let s = hub.status();
            if ok(&s) {
                return s;
            }
            assert!(Instant::now() < until, "timed out waiting for {what}: {s:?}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    #[ignore]
    fn real_hub() {
        let dir = PathBuf::from(std::env::var("CONCLAVE_TEST_HUB").expect("CONCLAVE_TEST_HUB"));
        let asset = this_asset().unwrap();
        let bytes = fs::read(dir.join(&asset.file)).unwrap();
        let sum = fs::read(dir.join(format!("{}.sha256", asset.file))).unwrap();
        let data = std::env::temp_dir().join(format!("conclave-real-hub-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let (base, _h) = super::tests_support_serve(vec![(format!("/v0.0.1/{}", asset.file), bytes), (format!("/v0.0.1/{}.sha256", asset.file), sum)]);
        let user_home = data.join("user-conclave");
        let host = Arc::new(TestHost {
            port: Mutex::new((Some(std::env::var("CONCLAVE_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(17717)), false)),
            token: Mutex::default(),
            daemon: std::env::var("CONCLAVE_TEST_DAEMON").ok().map(PathBuf::from),
            conclave_home: user_home.clone(),
        });
        let setup = Setup { layout: Layout { data: data.join("app") }, version: "0.0.1".into(), releases: base, bin: None, user_home: Some(user_home.clone()), home_dir: Some(data.clone()) };
        let hub = Hub::default();

        eprintln!("start: download, check, unpack, start, connect");
        hub.start(setup.clone(), host.clone());
        let s = wait_for(&hub, "running", 180, |s| s.phase == Phase::Running);
        let port = s.port.unwrap();
        let token = host.token.lock().unwrap().clone().expect("connected with the owner token");
        assert_eq!(home_token(&setup.layout.home()).as_deref(), Some(token.as_str()));
        assert!(setup.layout.log_file().is_file());
        assert!(setup.layout.home().join("logs").read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("hub-")), "the hub's own log files");
        let config_mode = {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(setup.layout.home().join("config.json")).unwrap().permissions().mode() & 0o777
        };
        assert_eq!(config_mode, 0o600, "the token file is this user's only");
        assert!(s.computer_error.is_none(), "{s:?}");
        {
            use std::os::unix::fs::PermissionsExt;
            let logs = setup.layout.home().join("logs");
            assert_eq!(fs::metadata(&logs).unwrap().permissions().mode() & 0o777, 0o700, "the log folder is this user's only");
            assert_eq!(fs::metadata(setup.layout.log_file()).unwrap().permissions().mode() & 0o777, 0o600, "hub.log is this user's only");
            let printed = fs::read_to_string(setup.layout.log_file()).unwrap();
            assert!(!printed.contains(&token), "the owner token is not in hub.log:\n{printed}");
            let day = fs::read_to_string(logs.join(format!("hub-{}.jsonl", today()))).unwrap_or_default();
            assert!(day.contains("\"host\":\"127.0.0.1\""), "the hub listens on this computer only");
            assert!(!day.contains(&token));
        }

        // the paired daemon, running in the foreground, comes online
        let mut daemon_run = host.daemon.as_ref().map(|d| Command::new(d).arg("run").env("CONCLAVE_HOME", &user_home).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap());
        if daemon_run.is_some() {
            let base = local_base(port);
            let until = Instant::now() + Duration::from_secs(20);
            loop {
                let list = crate::hub::devices(&base, &token).unwrap();
                if list.iter().any(|d| d.id != "local" && d.online) {
                    eprintln!("devices: {list:?}");
                    break;
                }
                assert!(Instant::now() < until, "the daemon did not come online: {list:?}");
                std::thread::sleep(Duration::from_millis(300));
            }
        }

        eprintln!("a token check from this user's other home is refused (it holds no key of ours)");
        assert_eq!(probe(port, &[(Owner::User, public_key_from_pem("-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEILgAzDM9Dn/DtYMcCAMnQxFPwoIIwRWX1H4WUH8h4xml\n-----END PRIVATE KEY-----\n").unwrap())]), OnPort::Taken);
        assert_eq!(probe(port, &keys(&setup)), OnPort::Ours(Owner::App));

        eprintln!("kill -9 the hub: it comes back after the backoff");
        let pid = s.pid.unwrap();
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
        let r = wait_for(&hub, "retrying", 10, |s| s.phase == Phase::Retrying);
        assert_eq!(r.retry_in, Some(1), "the first restart waits a second");
        eprintln!("it said: {}", words(&r));
        let s = wait_for(&hub, "running again", 60, |s| s.phase == Phase::Running && s.pid != Some(pid));
        assert_eq!(s.port, Some(port), "the same port");
        if let Some(d) = daemon_run.as_mut() {
            // the daemon reconnects by itself
            let base = local_base(port);
            let until = Instant::now() + Duration::from_secs(40);
            while !crate::hub::devices(&base, &token).unwrap().iter().any(|x| x.id != "local" && x.online) {
                assert!(Instant::now() < until, "the daemon did not reconnect");
                std::thread::sleep(Duration::from_millis(500));
            }
            eprintln!("the daemon is back online");
            let _ = d.id();
        }

        eprintln!("stop: closing stdin stops it cleanly");
        let pid = s.pid.unwrap();
        let t = Instant::now();
        assert!(hub.stop(Duration::from_secs(20)));
        eprintln!("stopped in {:?}", t.elapsed());
        assert!(t.elapsed() < Duration::from_secs(11), "stopped by closing stdin, not by the fallback");
        assert!(!Path::new(&format!("/proc/{pid}")).exists(), "the process is gone");
        assert!(port_free(port));
        let log = fs::read_to_string(setup.layout.home().join("logs").join(format!("hub-{}.jsonl", today()))).unwrap_or_default();
        assert!(log.contains("stdin closed"), "the hub logged why it stopped");

        eprintln!("start again: the same port, no download");
        hub.start(setup.clone(), host.clone());
        let s = wait_for(&hub, "running", 60, |s| s.phase == Phase::Running);
        assert_eq!(s.port, Some(port));

        eprintln!("the app goes away without a word: the hub stops by itself");
        let pid = s.pid.unwrap();
        // what the system does when the app dies: its end of the pipe closes. Here: stop() without waiting
        hub.stop(Duration::ZERO);
        let until = Instant::now() + Duration::from_secs(15);
        while Path::new(&format!("/proc/{pid}")).exists() {
            assert!(Instant::now() < until, "the hub outlived the app");
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Some(mut d) = daemon_run {
            let _ = d.kill();
            let _ = d.wait();
        }
        let _ = fs::remove_dir_all(&data);
    }

    /// `CONCLAVE_TEST_HUB=<release archive dir> cargo test real_port -- --ignored --nocapture`:
    /// the port is taken by another program, so the hub moves; then this
    /// user's own `conclave serve` already runs, so the app uses it and leaves it running.
    #[test]
    #[ignore]
    fn real_port_and_adopt() {
        let dir = PathBuf::from(std::env::var("CONCLAVE_TEST_HUB").expect("CONCLAVE_TEST_HUB"));
        let asset = this_asset().unwrap();
        let bin = dir.join(&asset.name).join(EXE);
        assert!(bin.is_file(), "unpack the release in {}", dir.display());
        let data = std::env::temp_dir().join(format!("conclave-real-port-{}", std::process::id()));
        let _ = fs::remove_dir_all(&data);
        let user_home = data.join("user-conclave");
        let setup = |app: &str| Setup { layout: Layout { data: data.join(app) }, version: "0.0.1".into(), releases: "http://127.0.0.1:9".into(), bin: Some(bin.clone()), user_home: Some(user_home.clone()), home_dir: Some(data.clone()) };
        let host = |port: u16| Arc::new(TestHost { port: Mutex::new((Some(port), false)), token: Mutex::default(), daemon: None, conclave_home: user_home.clone() });

        eprintln!("another program holds the port: the hub moves to the next one, and says so");
        let squatter = TcpListener::bind(("0.0.0.0", 17817)).unwrap();
        let hub = Hub::default();
        let h = host(17817);
        hub.start(setup("app-a"), h.clone());
        let s = wait_for(&hub, "running", 60, |s| s.phase == Phase::Running);
        assert_eq!(s.port, Some(17818));
        assert!(words(&s).contains("Port 17817 is in use by another program, so the hub uses port 17818"), "{}", words(&s));
        assert_eq!(*h.port.lock().unwrap(), (Some(17818), false), "the new port is kept for next time");
        assert!(hub.stop(Duration::from_secs(20)));
        drop(squatter);

        eprintln!("this user's own conclave serve runs on the port: the app uses it");
        fs::create_dir_all(&user_home).unwrap();
        // the port their hub is set up for: the app adopts a hub of this home only there (see `trusted`)
        fs::write(user_home.join("config.json"), r#"{ "server": { "port": 17819 } }"#).unwrap();
        let mut theirs = Command::new(&bin)
            .args(["serve", "--port", "17819"])
            .env("CONCLAVE_HOME", &user_home)
            .env("CONCLAVE_DETACHED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let until = Instant::now() + Duration::from_secs(60);
        while !home_key(&user_home).is_some_and(|k| who_answers(&local_base(17819), &[(Owner::User, k)]).is_some()) {
            assert!(Instant::now() < until, "their hub did not start");
            std::thread::sleep(Duration::from_millis(200));
        }
        let hub = Hub::default();
        let h = host(17819);
        // a hub that runs here needs no binary of the app's own: none here, and nothing to download from
        hub.start(Setup { bin: Some(data.join("no-binary")), ..setup("app-b") }, h.clone());
        let s = wait_for(&hub, "running", 30, |s| s.phase == Phase::Running);
        assert!(s.external && s.port == Some(17819), "{s:?}");
        assert!(words(&s).contains("The app did not start this hub"));
        assert_eq!(h.token.lock().unwrap().as_deref(), home_token(&user_home).as_deref(), "connected with their owner token");
        assert_eq!(*h.port.lock().unwrap(), (Some(17819), true), "remembered as adopted");
        assert!(!data.join("app-b").join("hub").join("config.json").exists(), "no second hub was started");

        eprintln!("their hub stops: the app waits for it, and never starts its own in its place");
        unsafe {
            libc::kill(theirs.id() as libc::pid_t, libc::SIGTERM);
        }
        let _ = theirs.wait();
        let s = wait_for(&hub, "waiting", 30, |s| s.phase == Phase::Waiting);
        assert!(words(&s).contains("started outside the app (conclave serve) and is not running"), "{}", words(&s));
        eprintln!("it said: {}", words(&s));

        eprintln!("turning it off leaves a hub it did not start alone");
        let mut theirs = Command::new(&bin).args(["serve", "--port", "17819"]).env("CONCLAVE_HOME", &user_home).env("CONCLAVE_DETACHED", "1").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        hub.retry();
        wait_for(&hub, "running again", 60, |s| s.phase == Phase::Running && s.external);
        assert!(hub.stop(Duration::from_secs(10)));
        assert!(theirs.try_wait().unwrap().is_none(), "their hub still runs");
        unsafe {
            libc::kill(theirs.id() as libc::pid_t, libc::SIGTERM);
        }
        let _ = theirs.wait();
        let _ = fs::remove_dir_all(&data);
    }

    fn today() -> String {
        let out = Command::new("date").args(["-u", "+%Y-%m-%d"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

}

/// The file server of the tests, shared with the real run.
#[cfg(test)]
pub(crate) fn tests_support_serve(files: Vec<(String, Vec<u8>)>) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut req = [0u8; 2048];
            let n = stream.read(&mut req).unwrap_or(0);
            let line = String::from_utf8_lossy(&req[..n]).lines().next().unwrap_or("").to_string();
            let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
            match files.iter().find(|(p, _)| *p == path) {
                Some((_, body)) => {
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(body);
                }
                None => {
                    let _ = write!(stream, "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                }
            }
        }
    });
    (base, handle)
}
