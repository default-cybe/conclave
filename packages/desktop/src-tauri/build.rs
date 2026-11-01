fn main() {
    // Listing the app commands makes them deny-by-default, so only the bundled
    // connection page (see capabilities/default.json) can call them. The hub's
    // remote page never gets them, except computer_status, open_settings,
    // update_status and update_install (grant_hub_ipc in src/main.rs). The
    // local_hub_* commands start and stop a hub on this computer, so they are
    // the bundled page's only.
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
            // meeting mode: open and status for the hub page, the rest only for the overlay window
            "meeting_open",
            "meeting_status",
            "meeting_start",
            "meeting_pause",
            "meeting_stop",
            "meeting_click_through",
            "meeting_hide",
            "meeting_focusable",
            "meeting_set_height",
            "meeting_displays",
            "meeting_place",
            "meeting_stt_retry",
        ]),
    ))
    .expect("failed to run tauri-build");
}
