//! The daemon reports the same version as the CLI (packages/cli/package.json),
//! which the release sets to the tag. CONCLAVE_VERSION overrides it. The
//! target triple names the release file it updates from (src/update.rs).

fn main() {
    println!("cargo:rerun-if-env-changed=CONCLAVE_VERSION");
    println!("cargo:rerun-if-changed=../cli/package.json");
    let version = std::env::var("CONCLAVE_VERSION").ok().filter(|v| !v.is_empty()).or_else(cli_version).unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rustc-env=CONCLAVE_DAEMON_VERSION={version}");
    // the release file this binary updates from: conclave-daemon-<target> (src/update.rs)
    println!("cargo:rustc-env=CONCLAVE_DAEMON_TARGET={}", std::env::var("TARGET").unwrap_or_default());
    println!("cargo:rerun-if-changed=../core/src/update/update-key.pub");
}

fn cli_version() -> Option<String> {
    let text = std::fs::read_to_string("../cli/package.json").ok()?;
    let at = text.find("\"version\"")?;
    let rest = &text[at + "\"version\"".len()..];
    let rest = rest[rest.find(':')? + 1..].trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}
