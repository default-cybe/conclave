//! conclave-daemon: lets a Conclave hub use this computer's files, shells and
//! coding tools. It dials out to the hub over one WebSocket and serves the
//! device protocol (packages/core/src/machine/protocol.ts), like the
//! TypeScript daemon, in a small native binary. The command line follows
//! docs/design/DAEMON-SIDECAR.md; the design is docs/design/DAEMON-RUST.md.

// Windows: a GUI program, so the Run key and the desktop app open no console window.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod cli;
mod config;
mod conn;
mod env;
mod errors;
mod fsops;
mod import;
mod info;
mod js;
mod logring;
mod net;
mod paths;
mod private;
mod procs;
mod search;
mod server;
mod service;
mod syncthing;
mod update;

#[cfg(windows)]
fn attach_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};
    // SAFETY: plain Win32 calls; a terminal that started us gets our output, pipes stay as they are.
    unsafe {
        if GetStdHandle(STD_OUTPUT_HANDLE).is_null() {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

fn main() {
    #[cfg(windows)]
    attach_console();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(cli::main_with(argv));
}
