// ==============================================================================
// Ghita Agent — Native Computer-Use Module (Phase 1 Rust Rewrite)
// ==============================================================================
//
// Provides high-performance native implementations for:
//   - Screenshot capture via the `screenshots` crate (GDI on Windows,
//     screencapture on macOS, X11 on Linux). ~10-30 ms vs ~500 ms for the
//     previous PowerShell child_process approach.
//   - Mouse & keyboard control via the `enigo` crate (SetCursorPos / SendInput
//     on Windows, CGEvent on macOS, XDo on Linux). Sub-millisecond latency
//     with no child_process overhead and no event-loop blocking.
//   - Image resize via the `image` crate (Lanczos3 filter). ~5 ms for a
//     1920x1080 → 960x540 downscale, vs ~50-100 ms for Jimp/sharp bridges.
//
// All commands are registered as Tauri invoke handlers and consumed by the
// TypeScript TauriOperator in packages/computer-use/src/operators/tauri.ts.
// ==============================================================================

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use enigo::{Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use image::imageops::FilterType;
use screenshots::Screen;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// Public types — mirrored in TypeScript as ComputerUseScreenSize / ScreenCapture
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScreenSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScreenCapture {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<ScreenSize>,
    /// OS-reported DPI scale factor (e.g. 1.0, 1.25, 1.5, 2.0).
    /// The TypeScript layer uses this for undoDpiScale() to match
    /// the NutJSOperator behaviour on HiDPI displays.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_factor: Option<f64>,
}

// ---------------------------------------------------------------------------
// Managed state — holds the Enigo instance across invocations
// ---------------------------------------------------------------------------

/// enigo's macOS backend keeps a `CGEventSource` (`NonNull`, `!Send`); Tauri
/// command futures require `Send`, so we wrap `Enigo` in a newtype with an
/// explicit `unsafe impl Send`. Access is serialized through the `Mutex` and
/// enigo's API is only touched from command handlers (CGEventSource is a
/// thread-safe opaque CF handle in practice), which is the standard pattern
/// for Tauri + enigo on macOS.
pub(crate) struct SendableEnigo(Enigo);
unsafe impl Send for SendableEnigo {}
impl std::ops::Deref for SendableEnigo {
    type Target = Enigo;
    fn deref(&self) -> &Enigo {
        &self.0
    }
}
impl std::ops::DerefMut for SendableEnigo {
    fn deref_mut(&mut self) -> &mut Enigo {
        &mut self.0
    }
}

pub struct ComputerUseState {
    pub enigo: Mutex<Option<SendableEnigo>>,
}

impl ComputerUseState {
    pub fn new() -> Self {
        match Enigo::new(&Settings::default()) {
            Ok(enigo) => Self {
                enigo: Mutex::new(Some(SendableEnigo(enigo))),
            },
            Err(e) => {
                eprintln!("[GHITA] Failed to initialize enigo input controller: {e}");
                eprintln!(
                    "[GHITA] Computer use features (mouse/keyboard control) will be unavailable."
                );
                // Headless / no-display machines must not crash at startup —
                // input commands will return a clear error instead.
                Self {
                    enigo: Mutex::new(None),
                }
            }
        }
    }

    fn lock_enigo<'a>(
        state: &'a tauri::State<'a, ComputerUseState>,
    ) -> Result<std::sync::MutexGuard<'a, Option<SendableEnigo>>, String> {
        state.enigo.lock().map_err(|e| e.to_string())
    }

    fn require_enigo<'a>(
        guard: &'a mut std::sync::MutexGuard<'_, Option<SendableEnigo>>,
    ) -> Result<&'a mut Enigo, String> {
        guard
            .as_mut()
            .map(|s| &mut s.0)
            .ok_or_else(|| "Input controller unavailable (headless / no display)".to_string())
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Compute clamped dimensions preserving aspect ratio.
fn clamped_size(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge {
        return (width, height);
    }
    let ratio = max_edge as f64 / longest as f64;
    (
        (width as f64 * ratio).round() as u32,
        (height as f64 * ratio).round() as u32,
    )
}

/// Capture the primary display, optionally resize, and return base64 PNG.
fn capture_screen_impl(
    max_edge: Option<u32>,
    output_jpeg: bool,
    quality: Option<f32>,
) -> Result<ScreenCapture, String> {
    let screens = Screen::all().map_err(|e| format!("Screen::all failed: {e}"))?;
    let screen = screens.first().ok_or("No display found")?;

    let orig_w = screen.display_info.width;
    let orig_h = screen.display_info.height;
    let scale_factor = screen.display_info.scale_factor as f64;

    // screenshots::Screen::capture() already returns image::RgbaImage
    let rgba = screen
        .capture()
        .map_err(|e| format!("Screen capture failed: {e}"))?;

    let mut dyn_img = rgba;

    // Resize if needed
    if let Some(max_edge) = max_edge {
        let (nw, nh) = clamped_size(orig_w, orig_h, max_edge);
        if (nw, nh) != (orig_w, orig_h) {
            dyn_img = image::imageops::resize(&dyn_img, nw, nh, FilterType::Lanczos3);
        }
    }

    let (fw, fh) = (dyn_img.width(), dyn_img.height());

    // Encode
    let mut buf = Vec::with_capacity((fw * fh * 3) as usize);
    let mut cursor = std::io::Cursor::new(&mut buf);

    if output_jpeg {
        let q = quality.unwrap_or(0.85);
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut cursor,
            (q * 100.0).clamp(1.0, 100.0) as u8,
        );
        let rgb = image::DynamicImage::ImageRgba8(dyn_img).to_rgb8();
        image::ImageEncoder::write_image(enc, rgb.as_raw(), fw, fh, image::ColorType::Rgb8)
            .map_err(|e| format!("JPEG encode: {e}"))?;
    } else {
        let enc = image::codecs::png::PngEncoder::new(&mut cursor);
        image::ImageEncoder::write_image(enc, dyn_img.as_raw(), fw, fh, image::ColorType::Rgba8)
            .map_err(|e| format!("PNG encode: {e}"))?;
    }

    let mime = if output_jpeg {
        "image/jpeg"
    } else {
        "image/png"
    };

    Ok(ScreenCapture {
        mime_type: mime.to_string(),
        data: BASE64.encode(&buf),
        size: Some(ScreenSize {
            width: fw,
            height: fh,
        }),
        scale_factor: Some(scale_factor),
    })
}

/// Resolve a canonical key name (e.g. "Enter", "ctrl") to an enigo `Key`.
fn resolve_key(name: &str) -> Key {
    match name.to_lowercase().as_str() {
        "enter" | "return" => Key::Return,
        "escape" | "esc" => Key::Escape,
        "tab" => Key::Tab,
        "space" => Key::Space,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "page_up" => Key::PageUp,
        "pagedown" | "page_down" => Key::PageDown,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        "shift" => Key::Shift,
        "control" | "ctrl" => Key::Control,
        "alt" | "option" => Key::Alt,
        "meta" | "command" | "cmd" | "win" | "super" => Key::Meta,
        "capslock" | "caps_lock" | "caps" => Key::CapsLock,
        // enigo's macOS `Key` enum lacks these variants — fall back to the
        // layout-dependent char mapping on macOS, keep the real keys elsewhere.
        #[cfg(target_os = "macos")]
        "insert" | "printscreen" | "print_screen" | "prtsc" | "pause" | "numlock" | "num_lock" => {
            if let Some(ch) = name.chars().next() {
                Key::Unicode(ch)
            } else {
                Key::Space
            }
        }
        #[cfg(not(target_os = "macos"))]
        "insert" => Key::Insert,
        #[cfg(not(target_os = "macos"))]
        "printscreen" | "print_screen" | "prtsc" => Key::Print,
        #[cfg(not(target_os = "macos"))]
        "pause" => Key::Pause,
        #[cfg(not(target_os = "macos"))]
        "numlock" | "num_lock" => Key::Numlock,
        _ => {
            // Fall back to layout-dependent char mapping
            if let Some(ch) = name.chars().next() {
                Key::Unicode(ch)
            } else {
                Key::Space
            }
        }
    }
}

/// Map a string button name to an enigo `Button`.
fn resolve_button(name: &str) -> Button {
    match name.to_lowercase().as_str() {
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => Button::Left,
    }
}

// ===========================================================================
// Tauri commands
// ===========================================================================

/// Capture a screenshot of the primary display.
///
/// * `max_edge`    — optional longest-edge clamp (default: no resize)
/// * `mime_type`   — output format. Accepted values:
///   * `"image/jpeg"` (or `"jpeg"`, `"jpg"`) → encode as JPEG
///   * `"image/png"` (or `"png"`, anything else) → encode as PNG
///   * `None`                                       → default PNG
/// * `quality`     — JPEG quality 0.0–1.0 (default 0.85, ignored for PNG)
///
/// Bug #5: previously any value other than the literal string
/// `"image/jpeg"` was treated as PNG, which meant an `undefined`
/// (null) value, the string `"png"`, the string `"image/png"`, or
/// an accidental typo would all silently switch the format. The
/// new logic explicitly accepts the common aliases and returns a
/// clear `Result` for obviously-invalid values.
#[tauri::command]
pub fn computer_screenshot(
    max_edge: Option<u32>,
    mime_type: Option<String>,
    quality: Option<f32>,
) -> Result<ScreenCapture, String> {
    let jpeg = match mime_type.as_deref() {
        None => false,
        Some(s) => {
            let s = s.trim().to_ascii_lowercase();
            if s.is_empty() {
                false
            } else if s == "image/jpeg" || s == "jpeg" || s == "jpg" {
                true
            } else if s == "image/png" || s == "png" {
                false
            } else {
                return Err(format!(
                    "Unsupported mime_type: '{s}'. Use 'image/jpeg' or 'image/png'."
                ));
            }
        }
    };
    capture_screen_impl(max_edge, jpeg, quality)
}

/// Return the primary display resolution in physical pixels.
#[tauri::command]
pub fn computer_get_screen_size() -> Result<ScreenSize, String> {
    let screens = Screen::all().map_err(|e| format!("Screen::all failed: {e}"))?;
    let screen = screens.first().ok_or("No display found")?;
    Ok(ScreenSize {
        width: screen.display_info.width,
        height: screen.display_info.height,
    })
}

/// Move the mouse cursor to absolute screen coordinates.
#[tauri::command]
pub fn computer_move_mouse(
    x: i32,
    y: i32,
    state: tauri::State<'_, ComputerUseState>,
) -> Result<(), String> {
    let mut guard = ComputerUseState::lock_enigo(&state)?;
    let enigo = ComputerUseState::require_enigo(&mut guard)?;
    enigo
        .move_mouse(x, y, Coordinate::Abs)
        .map_err(|e| format!("move_mouse: {e}"))
}

/// Click a mouse button at an optional coordinate.
///
/// * `point`  — `{x, y}`; omit to click at the current cursor position
/// * `button` — `"left"` (default), `"right"`, or `"middle"`
#[tauri::command]
pub fn computer_click(
    point: Option<serde_json::Value>,
    button: Option<String>,
    state: tauri::State<'_, ComputerUseState>,
) -> Result<(), String> {
    let mut guard = ComputerUseState::lock_enigo(&state)?;
    let enigo = ComputerUseState::require_enigo(&mut guard)?;
    let btn = resolve_button(button.as_deref().unwrap_or("left"));

    if let Some(p) = point {
        let x = p.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let y = p.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|e| format!("move_mouse: {e}"))?;
    }

    enigo
        .button(btn, Direction::Click)
        .map_err(|e| format!("button_click: {e}"))
}

/// Type a string of text through the keyboard.
#[tauri::command]
pub fn computer_type_text(
    text: String,
    state: tauri::State<'_, ComputerUseState>,
) -> Result<(), String> {
    let mut guard = ComputerUseState::lock_enigo(&state)?;
    let enigo = ComputerUseState::require_enigo(&mut guard)?;
    enigo.text(&text).map_err(|e| format!("type_text: {e}"))
}

/// Press and release a single key by its canonical name.
///
/// Accepts names like `"Enter"`, `"ctrl"`, `"f5"`, `"shift"`, etc.
/// Falls back to `Key::Unicode(first_char)` for unrecognised names.
#[tauri::command]
pub fn computer_press_key(
    key: String,
    state: tauri::State<'_, ComputerUseState>,
) -> Result<(), String> {
    let mut guard = ComputerUseState::lock_enigo(&state)?;
    let enigo = ComputerUseState::require_enigo(&mut guard)?;
    let k = resolve_key(&key);
    enigo
        .key(k, Direction::Press)
        .map_err(|e| format!("key press: {e}"))?;
    enigo
        .key(k, Direction::Release)
        .map_err(|e| format!("key release: {e}"))
}

/// Cheap health probe — verifies that both screenshot and input subsystems
/// are reachable.  Returns a JSON object consumable by the TypeScript
/// `OperatorHealth` type.
#[tauri::command]
pub fn computer_health_check(
    state: tauri::State<'_, ComputerUseState>,
) -> Result<serde_json::Value, String> {
    let screenshot_ok = Screen::all().is_ok();
    // Reuse existing Enigo instance instead of creating a new one each call
    let input_ok = state.enigo.lock().map(|g| g.is_some()).unwrap_or(false);

    Ok(serde_json::json!({
        "ready": screenshot_ok && input_ok,
        "kind": "nutjs",
        "checkedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        "screenshot": screenshot_ok,
        "input": input_ok,
    }))
}

// ===========================================================================
// Window operations (T9.7 — nut.js v4 pattern)
// ===========================================================================

/// Find a top-level window by title substring (case-insensitive).
/// Returns the HWND as an isize for cross-platform serialization.
#[cfg(target_os = "windows")]
fn find_window_by_title(title_substring: &str) -> Result<isize, String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
    };

    struct EnumState {
        needle: String,
        found: Option<isize>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: isize) -> i32 {
        let state_ptr = lparam as *mut EnumState;
        if state_ptr.is_null() {
            return 1;
        }
        let state = &mut *state_ptr;

        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }

        let len = GetWindowTextLengthW(hwnd);
        if len == 0 {
            return 1;
        }

        let mut buf = vec![0u16; (len + 1) as usize];
        GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();

        if title.contains(&state.needle) {
            state.found = Some(hwnd as isize);
            return 0;
        }
        1
    }

    let needle_lower = title_substring.to_lowercase();
    let mut state = EnumState {
        needle: needle_lower,
        found: None,
    };

    unsafe { EnumWindows(Some(enum_callback), &mut state as *mut EnumState as isize) };

    state.found.ok_or_else(|| {
        format!(
            "No visible window found with title containing '{}'",
            title_substring
        )
    })
}

/// Move a window to the specified screen coordinates.
#[tauri::command]
pub fn computer_window_move(
    title: String,
    x: i32,
    y: i32,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
        };

        let hwnd = find_window_by_title(&title)?;

        let (w, h) = if width.is_some() || height.is_some() {
            let mut rect = unsafe { std::mem::zeroed() };
            unsafe { GetWindowRect(hwnd as _, &mut rect) };
            let cur_w = (rect.right - rect.left) as i32;
            let cur_h = (rect.bottom - rect.top) as i32;
            (width.unwrap_or(cur_w), height.unwrap_or(cur_h))
        } else {
            let mut rect = unsafe { std::mem::zeroed() };
            unsafe { GetWindowRect(hwnd as _, &mut rect) };
            (
                (rect.right - rect.left) as i32,
                (rect.bottom - rect.top) as i32,
            )
        };

        let ok = unsafe {
            SetWindowPos(
                hwnd as _,
                std::ptr::null_mut(),
                x,
                y,
                w,
                h,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
        if ok == 0 {
            return Err("SetWindowPos failed".to_string());
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title, x, y, width, height);
        Err("computer_window_move is only supported on Windows".to_string())
    }
}

/// Bring a window to the foreground (focus it).
#[tauri::command]
pub fn computer_window_focus(title: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetForegroundWindow, ShowWindow, SW_RESTORE,
        };

        let hwnd = find_window_by_title(&title)?;
        unsafe {
            ShowWindow(hwnd as _, SW_RESTORE);
        }
        let ok = unsafe { SetForegroundWindow(hwnd as _) };
        if ok == 0 {
            return Err("SetForegroundWindow failed".to_string());
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = title;
        Err("computer_window_focus is only supported on Windows".to_string())
    }
}

/// Minimize a window.
#[tauri::command]
pub fn computer_window_minimize(title: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_MINIMIZE};

        let hwnd = find_window_by_title(&title)?;
        unsafe {
            ShowWindow(hwnd as _, SW_MINIMIZE);
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = title;
        Err("computer_window_minimize is only supported on Windows".to_string())
    }
}

/// Wait until a window with the given title appears, polling at intervals.
#[tauri::command]
pub async fn computer_window_wait_for(
    title: String,
    timeout_ms: Option<u64>,
    interval_ms: Option<u64>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let timeout = timeout_ms.unwrap_or(10_000);
        let interval = interval_ms.unwrap_or(250);
        let start = std::time::Instant::now();

        loop {
            if find_window_by_title(&title).is_ok() {
                return Ok(());
            }
            if start.elapsed().as_millis() as u64 >= timeout {
                return Err(format!(
                    "Timed out after {}ms waiting for window '{}'",
                    timeout, title
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(interval)).await;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (title, timeout_ms, interval_ms);
        Err("computer_window_wait_for is only supported on Windows".to_string())
    }
}

// ===========================================================================
// Unit tests (run with `cargo test` inside src-tauri/)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamped_size_no_resize() {
        assert_eq!(clamped_size(1920, 1080, 1920), (1920, 1080));
        assert_eq!(clamped_size(800, 600, 1920), (800, 600));
    }

    #[test]
    fn test_clamped_size_downscale() {
        let (w, h) = clamped_size(3840, 2160, 1920);
        assert_eq!(w, 1920);
        assert_eq!(h, 1080);
    }

    #[test]
    fn test_clamped_size_square() {
        let (w, h) = clamped_size(4000, 4000, 1000);
        assert_eq!(w, 1000);
        assert_eq!(h, 1000);
    }

    #[test]
    fn test_clamped_size_portrait() {
        let (w, h) = clamped_size(1080, 2400, 1920);
        assert_eq!(w, 864);
        assert_eq!(h, 1920);
    }

    #[test]
    fn test_resolve_key_common() {
        assert!(matches!(resolve_key("Enter"), Key::Return));
        assert!(matches!(resolve_key("enter"), Key::Return));
        assert!(matches!(resolve_key("ctrl"), Key::Control));
        assert!(matches!(resolve_key("Shift"), Key::Shift));
        assert!(matches!(resolve_key("f12"), Key::F12));
    }

    #[test]
    fn test_resolve_key_fallback_unicode() {
        if let Key::Unicode(ch) = resolve_key("z") {
            assert_eq!(ch, 'z');
        } else {
            panic!("Expected Key::Unicode('z')");
        }
    }

    #[test]
    fn test_resolve_button() {
        assert!(matches!(resolve_button("left"), Button::Left));
        assert!(matches!(resolve_button("right"), Button::Right));
        assert!(matches!(resolve_button("middle"), Button::Middle));
        assert!(matches!(resolve_button("LEFT"), Button::Left));
    }
}
