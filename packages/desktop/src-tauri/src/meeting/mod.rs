//! Meeting mode on the desktop (docs/design/MEETING-MODE.md, track A): the
//! overlay window and its hiding, the IPC commands, hotkeys, and the worker
//! threads (meeting-mic, meeting-sys, meeting-stt, meeting-up, meeting-share).
//! Nothing here runs when no meeting does, except the one Ctrl/Cmd+Alt+M hotkey.

pub mod capture;
#[cfg(target_os = "macos")]
pub mod exclude_mac;
#[cfg(target_os = "windows")]
pub mod exclude_win;
pub mod models;
pub mod parakeet {
    pub mod model;
}
pub mod share_watch;
pub mod stt;
pub mod upload;
pub mod vad;
pub mod wire;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use capture::ChannelShared;
use wire::{ChannelState, DesktopMeetingStatus, Exclusion, Levels, MeetingStatus, QueueStatus, SttState, SttStatus};

pub const MEETING: &str = "meeting";
pub const KEY_TOGGLE: &str = "CommandOrControl+Alt+M";
const KEY_ANSWER: &str = "CommandOrControl+Alt+Enter";
const KEY_PAUSE: &str = "CommandOrControl+Alt+P";
const KEY_CLICK: &str = "CommandOrControl+Alt+T";
/// The exclusion of every window of the app is re-checked this often (7.2 step 7).
const SWEEP_EVERY: Duration = Duration::from_secs(2);

struct Run {
    id: String,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    mic: Arc<ChannelShared>,
    sys: Arc<ChannelShared>,
    stt: Arc<stt::Shared>,
    up: Arc<upload::Shared>,
}

static RUN: Mutex<Option<Run>> = Mutex::new(None);
static OPEN_ID: Mutex<Option<String>> = Mutex::new(None);
static STT: Mutex<Option<SttStatus>> = Mutex::new(None);
static EXCLUSION: Mutex<Exclusion> = Mutex::new(Exclusion::Unsupported);
static CLICK_THROUGH: AtomicBool = AtomicBool::new(false);
static HIDDEN_FOR_SHARE: AtomicBool = AtomicBool::new(false);
/// The owner hid it with the hotkey: share detection does not bring it back.
static HIDDEN_BY_OWNER: AtomicBool = AtomicBool::new(false);

fn channel(c: &ChannelShared) -> ChannelState {
    ChannelState { ok: c.ok.load(Ordering::Relaxed), device: c.device.lock().unwrap().clone(), error: c.error.lock().unwrap().clone() }
}

pub fn status() -> DesktopMeetingStatus {
    let run = RUN.lock().unwrap();
    let stt = STT.lock().unwrap().clone().unwrap_or(SttStatus { state: SttState::Loading, progress: None, error: None });
    let (mic, system, queue, live, paused) = match run.as_ref() {
        Some(r) => (
            channel(&r.mic),
            channel(&r.sys),
            QueueStatus {
                stt: r.stt.len.load(Ordering::Relaxed),
                upload: r.up.len.load(Ordering::Relaxed),
                dropped: r.stt.dropped.load(Ordering::Relaxed) + r.up.dropped.load(Ordering::Relaxed),
            },
            true,
            r.paused.load(Ordering::Relaxed),
        ),
        None => (ChannelState::default(), ChannelState::default(), QueueStatus::default(), false, false),
    };
    DesktopMeetingStatus {
        meeting_id: run.as_ref().map(|r| r.id.clone()).or_else(|| OPEN_ID.lock().unwrap().clone()),
        live,
        paused,
        click_through: CLICK_THROUGH.load(Ordering::Relaxed),
        hidden_for_share: HIDDEN_FOR_SHARE.load(Ordering::Relaxed),
        exclusion: *EXCLUSION.lock().unwrap(),
        mic,
        system,
        stt,
        queue,
    }
}

pub fn is_live() -> bool {
    RUN.lock().unwrap().is_some()
}

// ---- the overlay window (7.2, 7.3) ----

fn build(app: &AppHandle, url: Url) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(MEETING) {
        w.navigate(url).map_err(|e| e.to_string())?;
        return Ok(w);
    }
    let b = WebviewWindowBuilder::new(app, MEETING, WebviewUrl::External(url))
        .title("Conclave meeting")
        .inner_size(380.0, 520.0)
        .visible(false)
        .content_protected(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .shadow(false)
        .visible_on_all_workspaces(true);
    // transparency on macOS needs the private-API feature; the panel is opaque there
    #[cfg(not(target_os = "macos"))]
    let b = b.transparent(true);
    let w = b.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    exclude_mac::make_panel(&w)?;
    #[cfg(target_os = "windows")]
    if let Ok(h) = w.hwnd() {
        exclude_win::tool_window(h.0 as isize, true);
    }
    let handle = app.clone();
    w.on_window_event(move |e| {
        use tauri::WindowEvent::*;
        if matches!(e, Resized(_) | Moved(_) | ScaleFactorChanged { .. } | Focused(_)) {
            recheck(&handle);
        }
    });
    Ok(w)
}

/// Re-read the exclusion and set it only where it differs.
fn recheck(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    if let Some(w) = app.get_webview_window(MEETING) {
        if let Ok(h) = w.hwnd() {
            *EXCLUSION.lock().unwrap() = exclude_win::ensure(h.0 as isize);
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(|| {
            if let Some(x) = exclude_mac::ensure_all() {
                *EXCLUSION.lock().unwrap() = x;
            }
        });
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = app;
}

fn show(app: &AppHandle) {
    let Some(w) = app.get_webview_window(MEETING) else { return };
    #[cfg(target_os = "windows")]
    if let Ok(h) = w.hwnd() {
        *EXCLUSION.lock().unwrap() = exclude_win::show(h.0 as isize);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = w;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            // set before it is ordered in, so it is never composed shareable
            if let Some(x) = exclude_mac::ensure_all() {
                *EXCLUSION.lock().unwrap() = x;
            }
            use tauri_nspanel::ManagerExt;
            if let Ok(p) = handle.get_webview_panel(MEETING) {
                p.show();
            }
            if let Some(x) = exclude_mac::ensure_all() {
                *EXCLUSION.lock().unwrap() = x;
            }
        });
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = app;
        let _ = w.show();
    }
}

fn hide(app: &AppHandle) {
    let Some(w) = app.get_webview_window(MEETING) else { return };
    #[cfg(target_os = "windows")]
    if let Ok(h) = w.hwnd() {
        exclude_win::hide(h.0 as isize);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = w;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            use tauri_nspanel::ManagerExt;
            if let Ok(p) = handle.get_webview_panel(MEETING) {
                p.hide();
            }
        });
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = w.hide();
}

/// `meeting_hide`: the overlay's own hide button, same as the panic key.
pub fn hide_by_owner(app: &AppHandle) {
    HIDDEN_BY_OWNER.store(true, Ordering::Relaxed);
    hide(app);
}

fn visible(app: &AppHandle) -> bool {
    app.get_webview_window(MEETING).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

/// The panic key and the tray: one press hides; the next shows (or opens the setup screen).
pub fn toggle(app: &AppHandle) {
    if visible(app) {
        HIDDEN_BY_OWNER.store(true, Ordering::Relaxed);
        hide(app);
    } else if app.get_webview_window(MEETING).is_some() {
        HIDDEN_BY_OWNER.store(false, Ordering::Relaxed);
        HIDDEN_FOR_SHARE.store(false, Ordering::Relaxed);
        show(app);
    } else if let Err(e) = open(app, None) {
        eprintln!("conclave: meeting overlay: {e}");
    }
}

/// Open the overlay on `meeting_id`, or on its setup screen.
pub fn open(app: &AppHandle, meeting_id: Option<&str>) -> Result<(), String> {
    let base = crate::hub_page(app, "")?;
    let mut url = base.join("overlay.html").map_err(|e| e.to_string())?;
    url.set_query(None);
    if let Some(id) = meeting_id {
        url.query_pairs_mut().append_pair("meeting", id);
    }
    url.set_fragment(base.fragment());
    *OPEN_ID.lock().unwrap() = meeting_id.map(str::to_string);
    build(app, url)?;
    HIDDEN_BY_OWNER.store(false, Ordering::Relaxed);
    show(app);
    Ok(())
}

// ---- start and stop ----

fn set_stt(state: SttState, progress: Option<f32>, error: Option<String>) {
    *STT.lock().unwrap() = Some(SttStatus { state, progress, error });
}

fn check_meeting(base: &Url, token: &str, id: &str, client_id: &str) -> Result<(), String> {
    let mut url = base.join("api/meetings/").map_err(|e| e.to_string())?;
    url.path_segments_mut().map_err(|_| "bad hub address")?.pop_if_empty().push(id);
    let m: wire::Meeting = ureq::AgentBuilder::new()
        .resolver(crate::hub::Ipv4First)
        .timeout(Duration::from_secs(5))
        .build()
        .get(url.as_str())
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;
    if !matches!(m.status, MeetingStatus::Ready | MeetingStatus::Paused) {
        return Err("This meeting is not ready to listen.".into());
    }
    if m.audio_client_id.as_deref().is_some_and(|c| c != client_id) {
        return Err("Another Conclave app is listening to this meeting.".into());
    }
    Ok(())
}

fn spawn(name: &str, f: impl FnOnce() + Send + 'static) {
    if let Err(e) = std::thread::Builder::new().name(name.into()).spawn(f) {
        eprintln!("conclave: cannot start {name}: {e}");
    }
}

pub fn start(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(r) = RUN.lock().unwrap().as_ref() {
        if r.id == id {
            r.paused.store(false, Ordering::Relaxed);
            return Ok(());
        }
        return Err("End the meeting that is running first.".into());
    }
    let (base, token) = crate::hub_creds(app)?;
    let client_id = crate::meeting_client_id(app);
    check_meeting(&base, &token, id, &client_id)?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;

    let run = Run {
        id: id.to_string(),
        stop: Arc::new(AtomicBool::new(false)),
        paused: Arc::new(AtomicBool::new(false)),
        mic: Arc::default(),
        sys: Arc::default(),
        stt: Arc::new(stt::Shared::default()),
        up: Arc::new(upload::Shared::default()),
    };
    let t0 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let hub = upload::Hub::new(base, token, client_id, id.to_string(), t0);
    {
        let (up, stop) = (run.up.clone(), run.stop.clone());
        spawn("meeting-up", move || upload::run(&hub, &up, &stop));
    }
    {
        // model first (download on the first meeting), then capture, then the STT loop
        let (stt_shared, up, stop, paused, mic, sys) =
            (run.stt.clone(), run.up.clone(), run.stop.clone(), run.paused.clone(), run.mic.clone(), run.sys.clone());
        spawn("meeting-stt", move || {
            let dir = models::dir(&app_data);
            if !models::missing(&dir).is_empty() {
                set_stt(SttState::Downloading, Some(0.0), None);
                if let Err(e) = models::ensure(&dir, |p| set_stt(SttState::Downloading, Some(p), None)) {
                    set_stt(SttState::Failed, None, Some(e));
                    return;
                }
            }
            set_stt(SttState::Loading, None, None);
            let mut model = match stt::load(&dir) {
                Ok(m) => m,
                Err(e) => return set_stt(SttState::Failed, None, Some(e)),
            };
            set_stt(SttState::Ready, None, None);
            if stop.load(Ordering::Relaxed) {
                return stt::keep(model);
            }
            for (ch, shared, name) in [(wire::Channel::Me, mic, "meeting-mic"), (wire::Channel::Them, sys, "meeting-sys")] {
                let (q, stop, paused, idle) = (stt_shared.clone(), stop.clone(), paused.clone(), stt_shared.idle.clone());
                spawn(name, move || capture::run_channel(ch, shared, stop, paused, idle, |s| q.push(s.into())));
            }
            stt::run(&mut model, &stt_shared, &stop, |seg| up.push(seg));
            stt::keep(model);
        });
    }
    let stop = run.stop.clone();
    *RUN.lock().unwrap() = Some(run);
    register_keys(app);
    set_tray(app, Some("Listening (mic + system sound)"));
    let handle = app.clone();
    spawn("meeting-share", move || watch(&handle, &stop));
    Ok(())
}

pub fn stop(app: &AppHandle) {
    let Some(run) = RUN.lock().unwrap().take() else { return };
    run.stop.store(true, Ordering::Relaxed);
    run.stt.wake.notify_all();
    run.up.wake.notify_all();
    for key in [KEY_ANSWER, KEY_PAUSE, KEY_CLICK] {
        let _ = app.global_shortcut().unregister(key);
    }
    set_tray(app, None);
    HIDDEN_FOR_SHARE.store(false, Ordering::Relaxed);
    emit_status(app);
}

pub fn pause(app: &AppHandle, on: bool) {
    if let Some(r) = RUN.lock().unwrap().as_ref() {
        r.paused.store(on, Ordering::Relaxed);
    }
    set_tray(app, Some(if on { "Paused" } else { "Listening (mic + system sound)" }));
    emit_status(app);
}

pub fn click_through(app: &AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window(MEETING) {
        if w.set_ignore_cursor_events(on).is_ok() {
            CLICK_THROUGH.store(on, Ordering::Relaxed);
        }
    }
    emit_status(app);
}

/// Only the setup screen takes keyboard focus (7.6).
pub fn focusable(app: &AppHandle, on: bool) {
    let Some(w) = app.get_webview_window(MEETING) else { return };
    #[cfg(target_os = "windows")]
    if let Ok(h) = w.hwnd() {
        exclude_win::tool_window(h.0 as isize, !on);
    }
    let _ = w.set_focusable(on);
    if on {
        let _ = w.set_focus();
    }
}

fn set_tray(app: &AppHandle, line: Option<&str>) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = line.map(|l| format!("Conclave: {l}")).unwrap_or_else(|| "Conclave".into());
        let _ = tray.set_tooltip(Some(tip));
        // macOS shows this next to the icon: the recording indicator stays visible when the overlay is hidden
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(line.map(|l| if l == "Paused" { "Paused" } else { "● REC" }));
    }
}

fn register_keys(app: &AppHandle) {
    let gs = app.global_shortcut();
    let keys: [(&str, fn(&AppHandle)); 3] = [
        (KEY_ANSWER, |_| {
            if let Some(r) = RUN.lock().unwrap().as_ref() {
                r.up.request_answer();
            }
        }),
        (KEY_PAUSE, |app| {
            let on = RUN.lock().unwrap().as_ref().map(|r| !r.paused.load(Ordering::Relaxed)).unwrap_or(false);
            pause(app, on);
        }),
        (KEY_CLICK, |app| click_through(app, !CLICK_THROUGH.load(Ordering::Relaxed))),
    ];
    for (key, f) in keys {
        let r = gs.on_shortcut(key, move |app, _, e| {
            if e.state() == ShortcutState::Pressed {
                f(app);
            }
        });
        if let Err(e) = r {
            eprintln!("conclave: meeting hotkey {key} unavailable: {e}");
        }
    }
}

/// The toggle key is there from the start: it opens the setup screen when no meeting runs.
pub fn setup(app: &AppHandle) {
    let r = app.global_shortcut().on_shortcut(KEY_TOGGLE, |app, _, e| {
        if e.state() == ShortcutState::Pressed {
            toggle(app);
        }
    });
    if let Err(e) = r {
        eprintln!("conclave: meeting hotkey {KEY_TOGGLE} unavailable: {e}");
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        *EXCLUSION.lock().unwrap() = Exclusion::Unsupported;
    }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit_to(MEETING, "meeting://status", status());
}

/// `meeting-share`: share detection every 250 ms, exclusion sweep every 2 s,
/// levels at 4 per second and the status on change (at most 2 per second).
fn watch(app: &AppHandle, stop: &AtomicBool) {
    let mut debounce = share_watch::Debounce::default();
    let mut last_sweep = Instant::now();
    let mut last_status: Option<String> = None;
    let mut last_status_at = Instant::now() - Duration::from_secs(1);
    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(share_watch::POLL);
        let ended = RUN.lock().unwrap().as_ref().is_some_and(|r| r.up.ended.load(Ordering::Relaxed));
        if ended {
            stop_and_say(app);
            return;
        }
        if let Some(os) = share_watch::THIS_OS {
            let hit = share_watch::matches(os, &share_watch::windows());
            match debounce.step(hit.is_some(), Instant::now()) {
                share_watch::Act::Hide => {
                    HIDDEN_FOR_SHARE.store(true, Ordering::Relaxed);
                    hide(app);
                    set_tray(app, Some("Overlay hidden while you share"));
                }
                share_watch::Act::Restore => {
                    HIDDEN_FOR_SHARE.store(false, Ordering::Relaxed);
                    if !HIDDEN_BY_OWNER.load(Ordering::Relaxed) {
                        show(app);
                    }
                    set_tray(app, Some("Listening (mic + system sound)"));
                }
                share_watch::Act::None => {}
            }
        }
        if last_sweep.elapsed() >= SWEEP_EVERY {
            last_sweep = Instant::now();
            #[cfg(target_os = "windows")]
            if let Some(h) = app.get_webview_window(MEETING).and_then(|w| w.hwnd().ok()) {
                exclude_win::sweep(h.0 as isize);
            }
            recheck(app);
        }
        if let Some(r) = RUN.lock().unwrap().as_ref() {
            let _ = app.emit_to(MEETING, "meeting://level", Levels { me: r.mic.level(), them: r.sys.level() });
        }
        let s = status();
        let text = serde_json::to_string(&s).unwrap_or_default();
        if last_status.as_deref() != Some(text.as_str()) && last_status_at.elapsed() >= Duration::from_millis(500) {
            let _ = app.emit_to(MEETING, "meeting://status", s);
            last_status = Some(text);
            last_status_at = Instant::now();
        }
    }
}

fn stop_and_say(app: &AppHandle) {
    stop(app);
    eprintln!("conclave: the hub ended the meeting");
}
