//! Meeting mode on the desktop (docs/design/MEETING-MODE.md, track A): the
//! overlay window and its hiding, the IPC commands, hotkeys, and the worker
//! threads (meeting-mic, meeting-sys, meeting-stt, meeting-up, meeting-share).
//! Nothing here runs when no meeting does, except the one Ctrl/Cmd+Alt+M hotkey.

pub mod capture;
pub mod cloud;
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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
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
/// The previous and next answer (the overlay's "n of m"), sent as meeting://nav -1 or 1.
const KEY_PREV: &str = "CommandOrControl+Alt+[";
const KEY_NEXT: &str = "CommandOrControl+Alt+]";
/// The overlay never gets shorter than its compact bar nor taller than this share of the screen.
const MIN_HEIGHT: f64 = 96.0;
const MAX_SCREEN_SHARE: f64 = 0.75;
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
/// Who transcribes ("assemblyai", "deepgram", "local") and why it fell back, if it did.
static PROVIDER: Mutex<Option<&'static str>> = Mutex::new(None);
static NOTE: Mutex<Option<String>> = Mutex::new(None);
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
    let stt = STT.lock().unwrap().clone().unwrap_or(SttStatus { state: SttState::Loading, progress: None, error: None, provider: None });
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
    let nav = app.clone();
    let b = WebviewWindowBuilder::new(app, MEETING, WebviewUrl::External(url))
        // the same guard as the main and quick windows: this window holds the capture commands
        .on_navigation(move |url| crate::allow_navigation(&nav, url))
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
    let note = NOTE.lock().unwrap().clone();
    let provider = PROVIDER.lock().unwrap().map(str::to_string);
    *STT.lock().unwrap() = Some(SttStatus { state, progress, error: error.or(note), provider });
}

/// The provider or the fallback note changed: the same state, with them.
fn set_provider(provider: Option<&'static str>, note: Option<String>) {
    *PROVIDER.lock().unwrap() = provider;
    *NOTE.lock().unwrap() = note;
    let cur = STT.lock().unwrap().clone();
    match cur {
        Some(c) => set_stt(c.state, c.progress, if c.state == SttState::Failed { c.error } else { None }),
        None => set_stt(SttState::Loading, None, None),
    }
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
    log::info!("meeting {id}: start");
    *STT.lock().unwrap() = None;
    set_provider(None, None);

    let run = Run {
        id: id.to_string(),
        stop: Arc::new(AtomicBool::new(false)),
        paused: Arc::new(AtomicBool::new(false)),
        mic: Arc::default(),
        sys: Arc::default(),
        stt: Arc::new(stt::Shared::default()),
        up: Arc::new(upload::Shared::default()),
    };
    let hub = Arc::new(upload::Hub::new(base, token, client_id, id.to_string(), wire::now_ms()));
    {
        let (up, stop, hub) = (run.up.clone(), run.stop.clone(), hub.clone());
        spawn("meeting-up", move || upload::run(&hub, &up, &stop));
    }
    let pipeline = Pipeline {
        app_data,
        stt: run.stt.clone(),
        up: run.up.clone(),
        stop: run.stop.clone(),
        paused: run.paused.clone(),
        mic: run.mic.clone(),
        sys: run.sys.clone(),
        seqs: Arc::default(),
        local: Arc::default(),
        hub,
    };
    spawn("meeting-stt", move || pipeline.begin());
    let stop = run.stop.clone();
    *RUN.lock().unwrap() = Some(run);
    register_keys(app);
    set_tray(app, Some("Listening (mic + system sound)"));
    let handle = app.clone();
    spawn("meeting-share", move || watch(&handle, &stop));
    Ok(())
}

/// The speech to text side of one meeting, shared by its threads.
#[derive(Clone)]
struct Pipeline {
    app_data: PathBuf,
    stt: Arc<stt::Shared>,
    up: Arc<upload::Shared>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    mic: Arc<ChannelShared>,
    sys: Arc<ChannelShared>,
    /// One numbering per channel for the cloud and the local model: a fallback leaves no gap.
    seqs: Arc<Mutex<stt::Seqs>>,
    /// The local model was started (once per meeting).
    local: Arc<AtomicBool>,
    hub: Arc<upload::Hub>,
}

impl Pipeline {
    /// Capture starts at once; each channel's cloud thread asks the hub for its own token
    /// meanwhile (audio waits in the feed, `cloud::FEED_FRAMES`), retries a failed one,
    /// and hands the channel to the model on this computer when the hub has no key or
    /// the provider keeps failing. Never waits for a model download.
    fn begin(self) {
        log::info!("meeting: capture starts; asking the hub for cloud speech to text");
        // nothing from the last meeting: loading until a provider answers or local takes over
        *STT.lock().unwrap() = None;
        set_provider(None, None);
        for (ch, shared, name) in [(wire::Channel::Me, self.mic.clone(), "meeting-mic"), (wire::Channel::Them, self.sys.clone(), "meeting-sys")] {
            let on = Arc::new(AtomicBool::new(true));
            let (tx, rx) = sync_channel(cloud::FEED_FRAMES);
            {
                let (p, on) = (self.clone(), on.clone());
                spawn(if ch == wire::Channel::Me { "meeting-cloud-me" } else { "meeting-cloud-them" }, move || {
                    let hub = p.hub.clone();
                    // the first session of the meeting names the provider; a reopen keeps any fallback note
                    let opened = |provider: cloud::Provider| {
                        if PROVIDER.lock().unwrap().is_none() {
                            set_provider(Some(provider.name()), None);
                            set_stt(SttState::Ready, None, None);
                        }
                    };
                    let r = cloud::run(ch, None, || hub.stt_token(), &rx, &p.stop, p.hub.t0, &p.seqs, opened, |s| p.up.push(s));
                    if let Err(e) = r {
                        on.store(false, Ordering::Relaxed);
                        if e == cloud::NO_KEY {
                            log::info!("meeting: {ch:?}: speech to text on this computer (no cloud key on the hub)");
                            set_provider(Some("local"), None);
                        } else {
                            log::warn!("meeting: {ch:?} falls back to the model on this computer: {e}");
                            let who = if ch == wire::Channel::Me { "Mic" } else { "System sound" };
                            let provider = PROVIDER.lock().unwrap().unwrap_or("local");
                            set_provider(Some(provider), Some(format!("{who}: cloud speech to text failed ({e}); using the model on this computer.")));
                        }
                        p.start_local();
                    }
                });
            }
            let (q, stop, paused, idle) = (self.stt.clone(), self.stop.clone(), self.paused.clone(), self.stt.idle.clone());
            spawn(name, move || capture::run_channel(ch, shared, stop, paused, idle, on, Some(tx), |s| q.push(s.into())));
        }
    }

    /// The local model: verified (downloaded on the first meeting), loaded, then the STT loop.
    /// Speech the VAD finds meanwhile waits in the queue.
    fn start_local(&self) {
        if self.local.swap(true, Ordering::SeqCst) {
            return;
        }
        let p = self.clone();
        spawn("meeting-stt-local", move || {
            let dir = models::dir(&p.app_data);
            if !models::ready(&dir) {
                log::info!("meeting: speech model not verified yet, checking or downloading it");
                set_stt(SttState::Downloading, Some(0.0), None);
                if let Err(e) = models::ensure(&dir, |x| set_stt(SttState::Downloading, Some(x), None)) {
                    log::error!("meeting: speech model: {e}");
                    set_stt(SttState::Failed, None, Some(e));
                    return;
                }
            }
            set_stt(SttState::Loading, None, None);
            let mut model = match stt::load(&dir) {
                Ok(m) => m,
                Err(e) => {
                    log::error!("meeting: {e}");
                    return set_stt(SttState::Failed, None, Some(e));
                }
            };
            set_stt(SttState::Ready, None, None);
            if p.stop.load(Ordering::Relaxed) {
                return stt::keep(model);
            }
            stt::run(&mut model, &p.stt, &p.stop, &p.seqs, |seg| p.up.push(seg));
            stt::keep(model);
        });
    }
}

pub fn stop(app: &AppHandle) {
    let Some(run) = RUN.lock().unwrap().take() else { return };
    log::info!("meeting {}: stop", run.id);
    run.stop.store(true, Ordering::Relaxed);
    run.stt.wake.notify_all();
    run.up.wake.notify_all();
    for key in [KEY_ANSWER, KEY_PAUSE, KEY_CLICK, KEY_PREV, KEY_NEXT] {
        let _ = app.global_shortcut().unregister(key);
    }
    set_tray(app, None);
    HIDDEN_FOR_SHARE.store(false, Ordering::Relaxed);
    emit_status(app);
}

/// The tray's "End meeting": stop listening, and end it on the hub so the wrap-up runs
/// (the overlay's own End button calls the hub itself). With no capture running yet,
/// the meeting the overlay shows is ended.
pub fn end(app: &AppHandle) {
    if let Some(r) = RUN.lock().unwrap().as_ref() {
        // meeting-up sends the last segments first, then the end
        r.up.end_on_hub.store(true, Ordering::Relaxed);
    } else if let Some(id) = OPEN_ID.lock().unwrap().clone() {
        if let Ok((base, token)) = crate::hub_creds(app) {
            let client_id = crate::meeting_client_id(app);
            spawn("meeting-end", move || {
                let _ = upload::Hub::new(base, token, client_id, id, 0).end();
            });
        }
    }
    stop(app);
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

/// The height the overlay asks for, in logical px, kept between the compact bar
/// and 75 % of the screen's logical height.
pub fn clamp_height(want: f64, screen: f64) -> f64 {
    let max = (screen * MAX_SCREEN_SHARE).max(MIN_HEIGHT);
    if want.is_finite() { want.clamp(MIN_HEIGHT, max) } else { max }
}

/// `meeting_set_height`: the window fits the overlay's content, width unchanged.
/// Only set_size (tao's setContentSize on macOS): it never touches the
/// "focusable" ivar the NSPanel lacks (see focusable below).
pub fn set_height(app: &AppHandle, height: f64) -> Result<(), String> {
    let Some(w) = app.get_webview_window(MEETING) else { return Ok(()) };
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let screen = w.current_monitor().ok().flatten().map(|m| m.size().height as f64 / m.scale_factor()).unwrap_or(1080.0);
    let width = w.inner_size().map_err(|e| e.to_string())?.width as f64 / scale;
    w.set_size(tauri::LogicalSize::new(width, clamp_height(height, screen))).map_err(|e| e.to_string())
}

/// Only the setup screen takes keyboard focus (7.6).
pub fn focusable(app: &AppHandle, on: bool) -> Result<(), String> {
    let Some(w) = app.get_webview_window(MEETING) else { return Ok(()) };
    // Never tao's set_focusable on macOS: it writes TaoWindow's "focusable" ivar, which
    // the MeetingPanel class tauri-nspanel swaps in does not have, so objc2 panics
    // (`ivar "focusable" not found`) and the release build aborts. The panel is
    // non-activating and becomes key only when a text field needs it; this hands
    // the key status over or back.
    #[cfg(target_os = "macos")]
    {
        let _ = w;
        let handle = app.clone();
        app.run_on_main_thread(move || {
            use tauri_nspanel::ManagerExt;
            if let Ok(p) = handle.get_webview_panel(MEETING) {
                if on {
                    p.make_key_window();
                } else {
                    p.resign_key_window();
                }
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "windows")]
        if let Ok(h) = w.hwnd() {
            exclude_win::tool_window(h.0 as isize, !on);
        }
        w.set_focusable(on).map_err(|e| e.to_string())?;
        if on {
            w.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// The tray icon with a red dot in its lower right quarter (white ring): the
/// recording indicator on every OS, also while the overlay is hidden for a share.
pub fn with_rec_dot(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let r = (w.min(h) as f32) * 0.22;
    let (cx, cy) = (w as f32 - r - 1.0, h as f32 - r - 1.0);
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let px = match d {
                d if d <= r * 0.75 => [220, 30, 40, 255],
                d if d <= r => [255, 255, 255, 255],
                _ => continue,
            };
            let i = ((y * w + x) * 4) as usize;
            if let Some(p) = out.get_mut(i..i + 4) {
                p.copy_from_slice(&px);
            }
        }
    }
    out
}

fn set_tray(app: &AppHandle, line: Option<&str>) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = line.map(|l| format!("Conclave: {l}")).unwrap_or_else(|| "Conclave".into());
        let _ = tray.set_tooltip(Some(tip));
        if let Some(icon) = app.default_window_icon() {
            // capture runs (listening, paused or hidden for a share): the icon says so on every OS
            let icon = match line {
                Some(_) => tauri::image::Image::new_owned(with_rec_dot(icon.rgba(), icon.width(), icon.height()), icon.width(), icon.height()),
                None => icon.clone().to_owned(),
            };
            let _ = tray.set_icon(Some(icon));
        }
        // macOS shows this next to the icon: the recording indicator stays visible when the overlay is hidden
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(line.map(|l| if l == "Paused" { "Paused" } else { "● REC" }));
    }
}

fn register_keys(app: &AppHandle) {
    let gs = app.global_shortcut();
    let keys: [(&str, fn(&AppHandle)); 5] = [
        (KEY_PREV, |app| {
            let _ = app.emit_to(MEETING, "meeting://nav", -1);
        }),
        (KEY_NEXT, |app| {
            let _ = app.emit_to(MEETING, "meeting://nav", 1);
        }),
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

/// To the overlay, and to the main window, whose notify.ts stays quiet while a meeting listens (7.6).
fn emit_status(app: &AppHandle) {
    send_status(app, status());
}

fn send_status(app: &AppHandle, s: DesktopMeetingStatus) {
    let _ = app.emit_to(MEETING, "meeting://status", s.clone());
    let _ = app.emit_to(crate::MAIN, "meeting://status", s);
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
            send_status(app, s);
            last_status = Some(text);
            last_status_at = Instant::now();
        }
    }
}

fn stop_and_say(app: &AppHandle) {
    stop(app);
    log::info!("meeting: the hub ended the meeting");
}

#[cfg(test)]
mod tests {
    use super::{clamp_height, with_rec_dot};

    #[test]
    fn the_height_stays_between_the_compact_bar_and_three_quarters_of_the_screen() {
        assert_eq!(clamp_height(300.0, 1080.0), 300.0);
        assert_eq!(clamp_height(2000.0, 1080.0), 810.0);
        assert_eq!(clamp_height(10.0, 1080.0), 96.0);
        assert_eq!(clamp_height(f64::NAN, 1080.0), 810.0);
        assert_eq!(clamp_height(500.0, 100.0), 96.0);
    }

    #[test]
    fn the_rec_dot_is_red_in_the_corner_and_leaves_the_rest() {
        let (w, h) = (32u32, 32u32);
        let icon = vec![10u8; (w * h * 4) as usize];
        let out = with_rec_dot(&icon, w, h);
        assert_eq!(out.len(), icon.len());
        let at = |x: u32, y: u32| &out[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize];
        // the dot's centre is red, the opposite corner is untouched
        let c = (w as f32 - 32.0 * 0.22 - 1.0) as u32;
        assert_eq!(at(c, c), [220, 30, 40, 255]);
        assert_eq!(at(0, 0), [10, 10, 10, 10]);
    }
}
