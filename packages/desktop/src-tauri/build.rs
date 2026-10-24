fn main() {
    // Listing the app commands makes them deny-by-default, so only the bundled
    // connection page (see capabilities/default.json) can call them. The hub's
    // remote page never gets them, except computer_status and open_settings
    // (grant_hub_ipc in src/main.rs). The local_hub_* commands start and stop
    // a hub on this computer, so they are the bundled page's only.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_settings",
            "connect",
            "open_hub",
            "set_autostart",
            "computer_status",
            "computer_enable",
            "computer_disable",
            "open_settings",
            "local_hub_status",
            "local_hub_set",
            "local_hub_retry",
            "local_hub_lan",
            "local_hub_logs",
            "pair_phone",
            "open_remote_access",
            "update_status",
            "update_install",
            "update_auto",
            "terminal_status",
            "terminal_install",
            "terminal_remove",
            "hub_people",
            "login",
            "login_confirm",
            "login_cancel",
        ]),
    ))
    .expect("failed to run tauri-build");
}
