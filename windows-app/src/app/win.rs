//! Small Win32 helpers: message boxes, the clipboard (text), the default browser, the console
//! for the smoke test's result, known folders and the Windows build.

use std::path::{Path, PathBuf};

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
use windows::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, MessageBoxW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE, HWND_TOP, MESSAGEBOX_RESULT, MESSAGEBOX_STYLE,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNORMAL, WS_CLIPSIBLINGS,
};

/// A message box (modal to `owner` when given).
pub fn message_box(owner: Option<HWND>, text: &str, caption: &str, style: MESSAGEBOX_STYLE) -> MESSAGEBOX_RESULT {
    unsafe { MessageBoxW(owner, &HSTRING::from(text), &HSTRING::from(caption), style) }
}

/// Opens a (checked) web or mail link in the default browser, off the UI thread.
pub fn open_in_browser(url: String) {
    std::thread::spawn(move || unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(url.as_str()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
    });
}

/// Runs `f` with the clipboard open (it may be held by another program for a moment).
fn with_clipboard<T>(owner: Option<HWND>, f: impl FnOnce() -> Option<T>) -> Option<T> {
    for _ in 0..10 {
        if unsafe { OpenClipboard(owner) }.is_ok() {
            let result = f();
            let _ = unsafe { CloseClipboard() };
            return result;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    None
}

/// The clipboard's text, or `None` when it has none (a picture, files copied in Explorer).
pub fn clipboard_text(owner: Option<HWND>) -> Option<String> {
    if unsafe { IsClipboardFormatAvailable(u32::from(CF_UNICODETEXT.0)) }.is_err() {
        return None;
    }
    with_clipboard(owner, || unsafe {
        let handle = GetClipboardData(u32::from(CF_UNICODETEXT.0)).ok()?;
        let global = HGLOBAL(handle.0);
        let ptr = GlobalLock(global) as *const u16;
        if ptr.is_null() {
            return None;
        }
        let max = GlobalSize(global) / 2;
        let units = std::slice::from_raw_parts(ptr, max);
        let len = units.iter().position(|&u| u == 0).unwrap_or(max);
        let text = String::from_utf16_lossy(&units[..len]);
        let _ = GlobalUnlock(global);
        Some(text)
    })
}

/// Puts text on the clipboard.
pub fn set_clipboard_text(owner: Option<HWND>, text: &str) -> bool {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    with_clipboard(owner, || unsafe {
        EmptyClipboard().ok()?;
        let global = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).ok()?;
        let ptr = GlobalLock(global) as *mut u16;
        if ptr.is_null() {
            let _ = GlobalFree(Some(global));
            return None;
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
        let _ = GlobalUnlock(global);
        if SetClipboardData(u32::from(CF_UNICODETEXT.0), Some(HANDLE(global.0))).is_err() {
            let _ = GlobalFree(Some(global));
            return None;
        }
        Some(())
    })
    .is_some()
}

/// Writes the smoke test's result: to `file`, or to the console the app was started from (it
/// is a GUI program: it has none of its own).
pub fn smoke_output(file: Option<&Path>, line: &str) {
    use std::io::Write;
    if let Some(file) = file {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, format!("{line}\n"));
        return;
    }
    let inherited = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }.is_ok_and(|h| !h.is_invalid() && !h.0.is_null());
    if inherited {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
        return;
    }
    if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) }.is_ok() {
        if let Ok(mut console) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
            let _ = writeln!(console, "{line}");
        }
    }
}

/// %LOCALAPPDATA%\lu-minal (the window's settings and the web view's data live here).
pub fn data_dir() -> PathBuf {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData").join("Local")))
        .unwrap_or_else(std::env::temp_dir);
    local.join("lu-minal")
}

/// The user's profile folder, where lu-minal starts.
pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("C:\\")))
}

/// The installed WebView2 Runtime's version, or why there is none.
pub fn webview2_version() -> Result<String, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    let mut version = windows::core::PWSTR::null();
    unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut version) }.map_err(|e| e.message())?;
    let version = webview2_com::take_pwstr(version);
    if version.is_empty() {
        return Err("the WebView2 Runtime is not installed".into());
    }
    Ok(version)
}

/// The Windows build number (19045, 26100, ...), for xterm.js's ConPTY heuristics.
pub fn windows_build() -> u32 {
    windows_version::OsVersion::current().build
}

/// Lets the web views' container windows clip each other (the pane lies over the terminal's
/// web view) and puts `top` above the others.
pub fn clip_siblings(hwnds: &[HWND], top: Option<HWND>) {
    unsafe {
        for &hwnd in hwnds {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            if style & WS_CLIPSIBLINGS.0 as isize == 0 {
                SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_CLIPSIBLINGS.0 as isize);
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | windows::Win32::UI::WindowsAndMessaging::SWP_NOZORDER,
                );
            }
        }
        if let Some(top) = top {
            let _ = SetWindowPos(top, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

/// Finds a program on the PATH (for the OSC smoke test's node).
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
}
