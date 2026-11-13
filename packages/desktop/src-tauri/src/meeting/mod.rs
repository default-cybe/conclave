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
pub mod place;
pub mod share_watch;
pub mod stt;
#[cfg(target_os = "macos")]
pub mod tap_mac;
pub mod upload;
pub mod vad;
pub mod wire;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use capture::ChannelShared;
use wire::{ChannelState, DesktopMeetingStatus, Exclusion, Levels, MeetingStatus, QueueStatus, SttState, SttStatus};

pub const MEETING: &str = "meeting";
pub const KEY_TOGGLE: &str = "CommandOrControl+Alt+M";
const KEY_ANSWER: &str = "CommandOrControl+Alt+Enter";
const KEY_PAUSE: &str = "CommandOrControl+Alt+P";
const KEY_CLICK: &str = "CommandOrControl+Alt+T";
/// When another app holds Cmd/Ctrl+Alt+T; the overlay menu shows whichever one registered.
const KEY_CLICK_FALLBACK: &str = "CommandOrControl+Alt+Shift+T";
/// The previous and next answer (the overlay's "n of m"), sent as meeting://nav -1 or 1.
const KEY_PREV: &str = "CommandOrControl+Alt+[";
const KEY_NEXT: &str = "CommandOrControl+Alt+]";
/// The overlay to the next or previous display (meeting://display 1 or -1). With Shift: Teams
/// takes Ctrl+Alt+Left/Right, Intel graphics rotate the screen on it, and Windows moves the
/// focused window between displays with Win+Shift+Left/Right.
const KEY_DISPLAY_NEXT: &str = "CommandOrControl+Alt+Shift+Right";
const KEY_DISPLAY_PREV: &str = "CommandOrControl+Alt+Shift+Left";
/// A docked overlay slides out (or back in): meeting://peek.
const KEY_PEEK: &str = "CommandOrControl+Alt+O";
/// macOS window levels: floating (4), and over the menu bar for the notch
/// (NSMainMenuWindowLevel 24 + 3, as TheBoredTeam/boring.notch and Ebullioscopic/Atoll).
#[cfg(target_os = "macos")]
const LEVEL_FLOATING: i64 = 4;
#[cfg(target_os = "macos")]
const LEVEL_NOTCH: i64 = 27;
/// The overlay never gets shorter than its compact bar nor taller than this share of the screen.
const MIN_HEIGHT: f64 = 96.0;
const MAX_SCREEN_SHARE: f64 = 0.75;
/// The exclusion of every window of the app is re-checked this often (7.2 step 7).
const SWEEP_EVERY: Duration = Duration::from_secs(2);
/// meeting://level goes out when a channel's level moved this much: each emit runs script in the overlay.
const LEVEL_STEP: f32 = 0.02;
/// "them" quiet this long while "me" talks: the overlay says the meeting is not heard.
const NOT_HEARING_AFTER: Duration = Duration::from_secs(20);
pub const NOT_HEARING: &str = "Not hearing the meeting. Check the meeting app's speaker.";
/// Peak levels: any sound on the system channel, speech on the mic.
const THEM_SOUND: f32 = 0.005;
const ME_SPEECH: f32 = 0.08;

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
/// The click-through hotkey that registered: KEY_CLICK, its fallback, or none.
static CLICK_KEY: Mutex<Option<&'static str>> = Mutex::new(None);
static HIDDEN_FOR_SHARE: AtomicBool = AtomicBool::new(false);
/// The owner hid it with the hotkey: share detection does not bring it back.
static HIDDEN_BY_OWNER: AtomicBool = AtomicBool::new(false);
/// The overlay's native blur is on (it is from build). Off while docked or in the notch,
/// where the window is briefly larger than the panel as it slides or grows.
static BLUR: AtomicBool = AtomicBool::new(true);
/// The panel sits over the menu bar (notch mode).
static NOTCH: AtomicBool = AtomicBool::new(false);
/// The cursor was over the overlay at the last look (meeting://hover on change).
static HOVER: AtomicBool = AtomicBool::new(false);
/// Docked to an edge and auto-hidden: the window is the 10 px tab, which shows no level.
static EDGE_TAB: AtomicBool = AtomicBool::new(false);
/// Meetings on for the account (the hub page says, meeting_enabled). On until it says otherwise, so an older hub keeps them.
static ENABLED: AtomicBool = AtomicBool::new(true);
/// The tray's meeting items, kept so they can come back after Meetings was off.
static TRAY_ITEMS: Mutex<Vec<MenuItem<Wry>>> = Mutex::new(Vec::new());

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
        click_key: CLICK_KEY.lock().unwrap().map(str::to_string),
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
    let (width, height) = place::primary_work(app).map_or(place::DEFAULT_SIZE, |(w, h)| place::default_size(w, h));
    let b = WebviewWindowBuilder::new(app, MEETING, WebviewUrl::External(url))
        // the same guard as the main and quick windows: this window holds the capture commands
        .on_navigation(move |url| crate::allow_navigation(&nav, url))
        .title("Conclave meeting")
        .inner_size(width, height)
        .visible(false)
        .content_protected(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .shadow(false)
        .visible_on_all_workspaces(true)
        // translucent: on macOS this needs tauri's macos-private-api feature (tauri.conf.json macOSPrivateApi)
        .transparent(true);
    let w = b.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        exclude_mac::make_panel(&w)?;
        // after the class swap, on this same main thread (make_panel checks it): a blur view
        // under the webview. sharingType belongs to the window, so a subview leaves it alone,
        // and show() sets and reads it back after this anyway.
        use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
        if let Err(e) = window_vibrancy::apply_vibrancy(&w, NSVisualEffectMaterial::HudWindow, Some(NSVisualEffectState::Active), Some(10.0)) {
            log::warn!("meeting overlay: no vibrancy: {e}");
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(h) = w.hwnd() {
        exclude_win::tool_window(h.0 as isize, true);
        // Windows 11 22H2+ only (the DWM system backdrop). Windows 10's acrylic lags on drag and
        // resize, so there the page's own translucent dark panel is the background. The display
        // affinity is a separate attribute; show() sets and verifies it after this.
        if windows_version::OsVersion::current() >= windows_version::OsVersion::new(10, 0, 0, 22523) {
            if let Err(e) = window_vibrancy::apply_acrylic(&w, None) {
                log::warn!("meeting overlay: no acrylic: {e}");
            }
        }
    }
    let handle = app.clone();
    w.on_window_event(move |e| {
        use tauri::WindowEvent::*;
        if matches!(e, Resized(_) | Moved(_) | ScaleFactorChanged { .. } | Focused(_)) {
            recheck(&handle);
        }
        if matches!(e, ScaleFactorChanged { .. }) {
            if let Some(w) = handle.get_webview_window(MEETING) {
                place::refresh_primary_scale(&w);
            }
        }
        // the page snaps it once the drag settles (overlay/dock.ts): the OS says nothing when a drag ends
        if let Moved(p) = e {
            if let Some(w) = handle.get_webview_window(MEETING) {
                let _ = handle.emit_to(MEETING, "meeting://moved", place::moved(&w, *p));
            }
        }
    });
    Ok(w)
}

/// `meeting_place`: the page's placement (overlay/place.ts). The notch puts the panel over
/// the menu bar; docked and notch turn the native blur off. Capture exclusion is set again
/// after a level change.
pub fn place_window(app: &AppHandle, x: f64, y: f64, width: f64, height: f64, notch: bool, blur: bool) -> Result<(), String> {
    let Some(w) = app.get_webview_window(MEETING) else { return Ok(()) };
    let level_changed = NOTCH.swap(notch, Ordering::Relaxed) != notch;
    let blur_changed = BLUR.swap(blur, Ordering::Relaxed) != blur;
    #[cfg(target_os = "macos")]
    if level_changed || blur_changed {
        let (handle, win) = (app.clone(), w.clone());
        let _ = app.run_on_main_thread(move || {
            use tauri_nspanel::ManagerExt;
            if level_changed {
                if let Ok(p) = handle.get_webview_panel(MEETING) {
                    p.set_level(if notch { LEVEL_NOTCH } else { LEVEL_FLOATING });
                }
            }
            if blur_changed {
                use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
                let r = if blur {
                    window_vibrancy::apply_vibrancy(&win, NSVisualEffectMaterial::HudWindow, Some(NSVisualEffectState::Active), Some(10.0))
                } else {
                    window_vibrancy::clear_vibrancy(&win).map(|_| ())
                };
                if let Err(e) = r {
                    log::warn!("meeting overlay: vibrancy: {e}");
                }
            }
            if let Some(x) = exclude_mac::ensure_all() {
                *EXCLUSION.lock().unwrap() = x;
            }
        });
    }
    #[cfg(target_os = "windows")]
    if blur_changed && windows_version::OsVersion::current() >= windows_version::OsVersion::new(10, 0, 0, 22523) {
        let r = if blur { window_vibrancy::apply_acrylic(&w, None) } else { window_vibrancy::clear_acrylic(&w) };
        if let Err(e) = r {
            log::warn!("meeting overlay: acrylic: {e}");
        }
    }
    // not every OS reads both
    let _ = (level_changed, blur_changed);
    EDGE_TAB.store(edge_tab(notch, width, height), Ordering::Relaxed);
    place::place(&w, x, y, width, height)?;
    recheck(app);
    Ok(())
}

/// The tray's "Move overlay to next display": the page moves it (it knows the placement).
pub fn next_display(app: &AppHandle) {
    let _ = app.emit_to(MEETING, "meeting://display", 1);
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
        log::warn!("meeting overlay: {e}");
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
    /// One numbering per channel for the cloud and the local model.
    seqs: Arc<Mutex<stt::Seqs>>,
    /// The local model was started (once per meeting).
    local: Arc<AtomicBool>,
    hub: Arc<upload::Hub>,
}

impl Pipeline {
    /// Capture starts at once; each channel's cloud thread asks the hub for its own token and
    /// opens its socket meanwhile, before any audio (which waits in the feed, `cloud::FEED_FRAMES`),
    /// keeps it open until a pause or the end, and retries a failed one
    /// with backoff for the whole meeting. The model on this computer loads (and on the
    /// first meeting downloads) only when the owner chose Local in Settings: never as a
    /// fallback, it slows the computer down.
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
                    let who = if ch == wire::Channel::Me { "Mic" } else { "System sound" };
                    // a session that opens names the provider and clears an earlier failure; a failure
                    // shows in the overlay with Retry while the loop keeps trying the cloud
                    let state = |s: Result<cloud::Provider, String>| match s {
                        Ok(provider) => {
                            set_provider(Some(provider.name()), None);
                            set_stt(SttState::Ready, None, None);
                        }
                        Err(e) => {
                            let provider = *PROVIDER.lock().unwrap();
                            set_provider(provider, None);
                            set_stt(SttState::Failed, None, Some(format!("{who}: {e}")));
                        }
                    };
                    let r = cloud::run(ch, None, || hub.stt_token(), &rx, &p.stop, &p.paused, p.hub.t0, &p.seqs, state, |s| p.up.push(s));
                    match r {
                        // the owner picked Local in Settings: the only way the model here loads
                        Err(e) if e == cloud::LOCAL => {
                            log::info!("meeting: {ch:?}: speech to text on this computer (Local chosen in Settings)");
                            on.store(false, Ordering::Relaxed);
                            set_provider(Some("local"), None);
                            p.start_local();
                        }
                        Err(e) => log::error!("meeting: {ch:?}: speech to text stopped: {e}"),
                        Ok(()) => {}
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
    let click = CLICK_KEY.lock().unwrap().take();
    for key in [KEY_ANSWER, KEY_PAUSE, KEY_PREV, KEY_NEXT, KEY_DISPLAY_NEXT, KEY_DISPLAY_PREV, KEY_PEEK].into_iter().chain(click) {
        let _ = app.global_shortcut().unregister(key);
    }
    // nothing can turn it off once the hotkey is gone
    if CLICK_THROUGH.load(Ordering::Relaxed) {
        click_through(app, false);
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

/// Clicks pass through the overlay (on) or reach it again (off). On macOS the NSPanel's
/// setIgnoresMouseEvents runs on the main thread and is read back; the IPC command and the
/// hotkey both arrive on other threads.
pub fn click_through(app: &AppHandle, on: bool) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let r = app.run_on_main_thread(move || {
            use tauri_nspanel::ManagerExt;
            let took = match handle.get_webview_panel(MEETING) {
                Ok(p) => {
                    p.set_ignores_mouse_events(on);
                    p.as_panel().ignoresMouseEvents() == on
                }
                Err(_) => false,
            };
            set_click_through(&handle, on, took);
        });
        if let Err(e) = r {
            log::warn!("meeting: click-through {on}: main thread unavailable: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let took = app.get_webview_window(MEETING).is_some_and(|w| match w.set_ignore_cursor_events(on) {
            Ok(()) => true,
            Err(e) => {
                log::warn!("meeting: click-through {on}: {e}");
                false
            }
        });
        set_click_through(app, on, took);
    }
}

fn set_click_through(app: &AppHandle, on: bool, took: bool) {
    if took {
        CLICK_THROUGH.store(on, Ordering::Relaxed);
        log::info!("meeting: click-through {}", if on { "on" } else { "off" });
    } else {
        log::warn!("meeting: click-through {} did not take effect", if on { "on" } else { "off" });
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
        // no title next to the icon on macOS: the red dot on the icon is the recording indicator
    }
}

/// The first key that registers, each result in app.log.
fn first_registered(keys: &[&'static str], mut register: impl FnMut(&'static str) -> Result<(), String>) -> Option<&'static str> {
    keys.iter().copied().find(|&key| match register(key) {
        Ok(()) => {
            log::info!("meeting: hotkey {key} registered");
            true
        }
        Err(e) => {
            log::warn!("meeting: hotkey {key} unavailable: {e}");
            false
        }
    })
}

fn on_press(app: &AppHandle, key: &'static str, f: fn(&AppHandle)) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(key, move |app, _, e| {
            if e.state() == ShortcutState::Pressed {
                f(app);
            }
        })
        .map_err(|e| e.to_string())
}

fn register_keys(app: &AppHandle) {
    let click: fn(&AppHandle) = |app| click_through(app, !CLICK_THROUGH.load(Ordering::Relaxed));
    let key = first_registered(&[KEY_CLICK, KEY_CLICK_FALLBACK], |k| on_press(app, k, click));
    *CLICK_KEY.lock().unwrap() = key;
    let keys: [(&'static str, fn(&AppHandle)); 7] = [
        (KEY_DISPLAY_NEXT, next_display),
        (KEY_DISPLAY_PREV, |app| {
            let _ = app.emit_to(MEETING, "meeting://display", -1);
        }),
        (KEY_PEEK, |app| {
            let _ = app.emit_to(MEETING, "meeting://peek", ());
        }),
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
    ];
    for (key, f) in keys {
        first_registered(&[key], |k| on_press(app, k, f));
    }
}

/// The toggle key is there from the start: it opens the setup screen when no meeting runs.
/// The tray's meeting items, from build_tray.
pub fn keep_tray_items(items: Vec<MenuItem<Wry>>) {
    *TRAY_ITEMS.lock().unwrap() = items;
}

/// Meetings turned on or off for the account: the overlay hotkey and the tray's meeting items come and go.
/// A meeting that is running keeps its own hotkeys until it stops.
pub fn set_enabled(app: &AppHandle, on: bool) {
    if ENABLED.swap(on, Ordering::Relaxed) == on {
        return;
    }
    log::info!("meeting: {}", if on { "on" } else { "off" });
    if on {
        first_registered(&[KEY_TOGGLE], |k| on_press(app, k, toggle));
    } else {
        let _ = app.global_shortcut().unregister(KEY_TOGGLE);
    }
    let Some(menu) = crate::state(app).menu.lock().unwrap().clone() else { return };
    let items = TRAY_ITEMS.lock().unwrap();
    if on {
        // back under Quick ask, where build_tray put them
        let at = menu.items().ok().and_then(|all| all.iter().position(|k| k.id().as_ref() == "quick")).map_or(0, |i| i + 1);
        for (n, item) in items.iter().enumerate() {
            let _ = menu.insert(item, at + n);
        }
    } else {
        for item in items.iter() {
            let _ = menu.remove(item);
        }
    }
}

pub fn setup(app: &AppHandle) {
    first_registered(&[KEY_TOGGLE], |k| on_press(app, k, toggle));
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

/// The hidden edge tab is TAB (10) CSS px thick (overlay/place.ts); a shown panel or the notch pill is far wider.
fn edge_tab(notch: bool, width: f64, height: f64) -> bool {
    !notch && width.min(height) < 16.0
}

/// Send meeting://level? Only to an overlay on screen, and only when a level moved by
/// LEVEL_STEP or fell to silence (or none went out since it was shown).
fn should_emit(prev: Option<Levels>, next: Levels, visible: bool) -> bool {
    let moved = |a: f32, b: f32| (a - b).abs() >= LEVEL_STEP || (b == 0.0 && a != 0.0);
    visible && prev.map_or(true, |p| moved(p.me, next.me) || moved(p.them, next.them))
}

/// When "them" last had sound and "me" last spoke, from the sampled levels.
#[derive(Default)]
struct Hearing {
    since: Option<Instant>,
    them_at: Option<Instant>,
    me_at: Option<Instant>,
}

impl Hearing {
    /// True while "them" has been silent for 20 s and "me" spoke in that time.
    fn step(&mut self, l: Levels, now: Instant) -> bool {
        let since = *self.since.get_or_insert(now);
        if l.them >= THEM_SOUND {
            self.them_at = Some(now);
        }
        if l.me >= ME_SPEECH {
            self.me_at = Some(now);
        }
        let quiet = now.duration_since(self.them_at.unwrap_or(since)) >= NOT_HEARING_AFTER;
        quiet && self.me_at.is_some_and(|t| now.duration_since(t) < NOT_HEARING_AFTER)
    }
}

/// The system channel's note: set when the meeting is not heard, cleared only if it is that note.
fn note_not_hearing(sys: &ChannelShared, deaf: bool) {
    // device before error: ChannelShared::set locks them in that order
    let device = sys.device.lock().unwrap().clone();
    let mut err = sys.error.lock().unwrap();
    if deaf && err.is_none() {
        log::warn!("meeting: them: silent for 20 s while the mic hears speech ({})", device.as_deref().unwrap_or("no device"));
        *err = Some(NOT_HEARING.into());
    } else if !deaf && err.as_deref() == Some(NOT_HEARING) {
        log::info!("meeting: them: sound again");
        *err = None;
    }
}

/// `meeting-share`: share detection every 250 ms, exclusion sweep every 2 s,
/// levels at most 4 per second when they change and the status on change (at most 2 per second).
fn watch(app: &AppHandle, stop: &AtomicBool) {
    let mut debounce = share_watch::Debounce::default();
    let mut last_level: Option<Levels> = None;
    let mut last_sweep = Instant::now();
    let mut last_status: Option<String> = None;
    let mut last_status_at = Instant::now() - Duration::from_secs(1);
    let mut hearing = Hearing::default();
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
            // a display plugged in or its scale changed: the cached primary scale for the hover
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window(MEETING).filter(|_| place::wants_hover(NOTCH.load(Ordering::Relaxed), BLUR.load(Ordering::Relaxed))) {
                place::refresh_primary_scale(&w);
            }
        }
        if let Some(r) = RUN.lock().unwrap().as_ref() {
            let next = Levels { me: r.mic.level(), them: r.sys.level() };
            if r.paused.load(Ordering::Relaxed) {
                hearing = Hearing::default();
                note_not_hearing(&r.sys, false);
            } else {
                note_not_hearing(&r.sys, hearing.step(next, Instant::now()));
            }
            // the hide paths set these flags (hide() has no other caller): no window query per pass
            let shown = !HIDDEN_FOR_SHARE.load(Ordering::Relaxed) && !HIDDEN_BY_OWNER.load(Ordering::Relaxed) && !EDGE_TAB.load(Ordering::Relaxed);
            if should_emit(last_level, next, shown) {
                let _ = app.emit_to(MEETING, "meeting://level", next);
                last_level = Some(next);
            } else if !shown {
                last_level = None;
            }
        }
        // free, nothing hides on hover: no cursor and window queries 4 times a second
        let hover = place::wants_hover(NOTCH.load(Ordering::Relaxed), BLUR.load(Ordering::Relaxed));
        if let Some(inside) = app.get_webview_window(MEETING).filter(|_| hover).and_then(|w| place::cursor_inside(&w)) {
            if HOVER.swap(inside, Ordering::Relaxed) != inside {
                let _ = app.emit_to(MEETING, "meeting://hover", inside);
            }
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
    use super::{clamp_height, edge_tab, first_registered, should_emit, with_rec_dot, Hearing, Levels, KEY_CLICK, KEY_CLICK_FALLBACK};
    use std::time::{Duration, Instant};

    #[test]
    fn click_through_falls_back_to_shift_when_the_hotkey_is_taken() {
        let mut tried = vec![];
        let got = first_registered(&[KEY_CLICK, KEY_CLICK_FALLBACK], |k| {
            tried.push(k.to_string());
            if k == KEY_CLICK { Err("HotKey already registered".into()) } else { Ok(()) }
        });
        assert_eq!(got, Some(KEY_CLICK_FALLBACK));
        assert_eq!(tried, [KEY_CLICK, KEY_CLICK_FALLBACK]);
        assert_eq!(first_registered(&[KEY_CLICK, KEY_CLICK_FALLBACK], |_| Ok(())), Some(KEY_CLICK), "the first wins");
        assert_eq!(first_registered(&[KEY_CLICK, KEY_CLICK_FALLBACK], |_| Err("no".into())), None);
    }

    #[test]
    fn silence_from_them_while_me_talks_for_20_s_is_not_hearing() {
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_secs(s);
        let l = |me: f32, them: f32| Levels { me, them };
        let mut h = Hearing::default();
        assert!(!h.step(l(0.3, 0.0), at(0)));
        assert!(!h.step(l(0.3, 0.0), at(19)), "not yet 20 s");
        assert!(h.step(l(0.3, 0.0), at(20)), "20 s of silence while I talk");
        assert!(!h.step(l(0.0, 0.2), at(21)), "them is heard again");
        // both quiet: a pause in the meeting, not a wrong speaker
        let mut quiet = Hearing::default();
        assert!(!quiet.step(l(0.0, 0.0), at(0)));
        assert!(!quiet.step(l(0.01, 0.0), at(40)));
    }

    #[test]
    fn the_hidden_edge_tab_gets_no_levels_and_the_notch_pill_does() {
        assert!(edge_tab(false, 10.0, 64.0), "left or right tab");
        assert!(edge_tab(false, 64.0, 10.0), "top or bottom tab");
        assert!(!edge_tab(false, 360.0, 120.0), "docked and shown");
        assert!(!edge_tab(true, 290.0, 32.0), "notch pill: its tiny level stays");
    }

    #[test]
    fn levels_go_out_only_when_they_move_and_the_overlay_shows() {
        let l = |me: f32, them: f32| Levels { me, them };
        assert!(should_emit(None, l(0.0, 0.0), true), "the first after showing");
        assert!(!should_emit(Some(l(0.3, 0.1)), l(0.3, 0.1), true), "unchanged");
        assert!(!should_emit(Some(l(0.3, 0.1)), l(0.31, 0.1), true), "under the step");
        assert!(should_emit(Some(l(0.0, 0.0)), l(0.0, 0.02), true), "a 0.02 move");
        assert!(should_emit(Some(l(0.01, 0.0)), l(0.0, 0.0), true), "down to silence");
        assert!(!should_emit(None, l(0.9, 0.9), false), "hidden");
        // 10 s of silence at 4 passes a second: 40 emits before, 1 now
        let mut last = None;
        let sent = (0..40)
            .filter(|_| {
                let go = should_emit(last, l(0.0, 0.0), true);
                if go {
                    last = Some(l(0.0, 0.0));
                }
                go
            })
            .count();
        assert_eq!(sent, 1);
    }

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
