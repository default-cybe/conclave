//! Where the overlay sits (MEETING-MODE.md 7.7): the displays as the overlay page
//! sees them, and moving and sizing the window there. The snapping, docking and
//! notch math is the page's (packages/web/src/overlay/place.ts, unit-tested); this
//! only reports and applies.
//!
//! Units: positions are "desktop units", points on macOS and physical pixels
//! elsewhere. macOS moves in points across displays (tao#816 and tauri#7890: a
//! physical position there is scaled by the window's current display, so it can
//! land on the wrong one), Windows and Linux in virtual-screen pixels, which can
//! be negative left of or above the primary display. Sizes are CSS px.

use serde::Serialize;
use tauri::{AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use super::MEETING;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// macOS: NSScreen.safeAreaInsets.top and the widths of auxiliaryTopLeftArea and
/// auxiliaryTopRightArea, in points (zero on a screen without a notch).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct NotchInsets {
    pub top: f64,
    pub left: f64,
    pub right: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub id: String,
    pub frame: Rect,
    pub work: Rect,
    /// Desktop units per CSS px: 1 on macOS, the scale factor elsewhere.
    pub unit: f64,
    pub scale: f64,
    pub primary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notch: Option<NotchInsets>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Displays {
    pub displays: Vec<Display>,
    /// The overlay's top left, desktop units.
    pub window: Option<Rect>,
    pub mac: bool,
}

const MAC: bool = cfg!(target_os = "macos");

/// Physical px to desktop units: divided by the display's own scale on macOS (tao
/// builds a monitor's physical rect from its points times that scale), as is elsewhere.
pub fn to_units(pos: PhysicalPosition<i32>, size: PhysicalSize<u32>, scale: f64) -> Rect {
    let k = if MAC && scale > 0.0 { scale } else { 1.0 };
    Rect { x: pos.x as f64 / k, y: pos.y as f64 / k, w: size.width as f64 / k, h: size.height as f64 / k }
}

/// Names, made unique: two monitors of one model share a name ("Monitor #1234" on macOS).
pub fn ids(names: &[String]) -> Vec<String> {
    names
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let before = names[..i].iter().filter(|m| *m == n).count();
            if before == 0 { n.clone() } else { format!("{n} #{}", before + 1) }
        })
        .collect()
}

fn display(m: &Monitor, id: String, primary: Option<&Monitor>) -> Display {
    let scale = m.scale_factor();
    let wa = m.work_area();
    Display {
        id,
        frame: to_units(*m.position(), *m.size(), scale),
        work: to_units(wa.position, wa.size, scale),
        unit: if MAC { 1.0 } else { scale },
        scale,
        primary: primary.is_some_and(|p| p.position() == m.position() && p.size() == m.size()),
        notch: None,
    }
}

/// `meeting_displays`.
pub fn displays(app: &AppHandle) -> Result<Displays, String> {
    let Some(w) = app.get_webview_window(MEETING) else { return Err("the overlay is not open".into()) };
    let monitors = w.available_monitors().map_err(|e| e.to_string())?;
    let primary = w.primary_monitor().ok().flatten();
    let names: Vec<String> = monitors.iter().enumerate().map(|(i, m)| m.name().cloned().unwrap_or_else(|| format!("Display {}", i + 1))).collect();
    #[allow(unused_mut)]
    let mut list: Vec<Display> = monitors.iter().zip(ids(&names)).map(|(m, id)| display(m, id, primary.as_ref())).collect();
    #[cfg(target_os = "macos")]
    {
        let insets = notch_insets(app);
        for d in &mut list {
            // NSScreen and the monitor share x and width in points (y is flipped in AppKit)
            d.notch = insets.iter().find(|(x, wd, _)| (x - d.frame.x).abs() < 1.0 && (wd - d.frame.w).abs() < 1.0).map(|(_, _, n)| *n);
        }
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let window = w.outer_position().ok().map(|p| to_units(p, PhysicalSize::new(0, 0), scale));
    Ok(Displays { displays: list, window, mac: MAC })
}

/// Each screen's x and width in points with its notch insets, read on the main thread.
#[cfg(target_os = "macos")]
fn notch_insets(app: &AppHandle) -> Vec<(f64, f64, NotchInsets)> {
    let (tx, rx) = std::sync::mpsc::channel();
    let _ = app.run_on_main_thread(move || {
        use objc2::runtime::NSObjectProtocol;
        let Some(mtm) = objc2::MainThreadMarker::new() else { return };
        let list = objc2_app_kit::NSScreen::screens(mtm)
            .iter()
            .map(|s| {
                let f = s.frame();
                // macOS 12+ only: asking an older one would raise
                let n = if s.respondsToSelector(objc2::sel!(auxiliaryTopLeftArea)) {
                    NotchInsets { top: s.safeAreaInsets().top, left: s.auxiliaryTopLeftArea().size.width, right: s.auxiliaryTopRightArea().size.width }
                } else {
                    NotchInsets::default()
                };
                (f.origin.x, f.size.width, n)
            })
            .collect();
        let _ = tx.send(list);
    });
    rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap_or_default()
}

/// The overlay's top left in desktop units, from a Moved event's physical position.
pub fn moved(w: &WebviewWindow, p: PhysicalPosition<i32>) -> Rect {
    to_units(p, PhysicalSize::new(0, 0), w.scale_factor().unwrap_or(1.0))
}

/// `meeting_place`: top left in desktop units, size in CSS px. Position first, then size,
/// so a move to a display with another scale has its scale when the size is set.
pub fn place(w: &WebviewWindow, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if ![x, y, width, height].iter().all(|v| v.is_finite()) || width <= 0.0 || height <= 0.0 {
        return Err("bad overlay rect".into());
    }
    if MAC {
        w.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    } else {
        w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32)).map_err(|e| e.to_string())?;
    }
    w.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

/// Is the cursor over the overlay? The page's own hover misses it on macOS, where a
/// non-key panel's web view gets no mouse-moved events, so `watch` asks this. tao gives
/// the macOS cursor in the primary display's scale and the window in its own.
pub fn cursor_inside(w: &WebviewWindow) -> Option<bool> {
    let c = w.cursor_position().ok()?;
    let r = to_units(w.outer_position().ok()?, w.outer_size().ok()?, w.scale_factor().ok()?);
    let k = if MAC { w.primary_monitor().ok()??.scale_factor() } else { 1.0 };
    let (x, y) = (c.x / k, c.y / k);
    Some(x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_are_points_on_macos_and_pixels_elsewhere() {
        let r = to_units(PhysicalPosition::new(-2880, 0), PhysicalSize::new(2880, 1800), 2.0);
        if MAC {
            assert_eq!(r, Rect { x: -1440.0, y: 0.0, w: 1440.0, h: 900.0 });
        } else {
            assert_eq!(r, Rect { x: -2880.0, y: 0.0, w: 2880.0, h: 1800.0 });
        }
    }

    #[test]
    fn duplicate_names_get_a_number() {
        let names = ["Monitor #1".to_string(), "Built-in".to_string(), "Monitor #1".to_string()];
        assert_eq!(ids(&names), ["Monitor #1", "Built-in", "Monitor #1 #2"]);
    }
}
