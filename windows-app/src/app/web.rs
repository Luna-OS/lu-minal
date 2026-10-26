//! The two web views. The terminal's serves the app's own page (embedded, from a custom
//! protocol, under a strict CSP, no network) and is the only one with an IPC channel. The cloud
//! pane's shows claude.ai as it is: no IPC, no scripts of ours, the default user agent; the host
//! only decides where it may navigate (see `urls`).

use std::borrow::Cow;
use std::path::PathBuf;

use tao::event_loop::EventLoopProxy;
use tao::window::Window;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, COREWEBVIEW2_KEY_EVENT_KIND, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    COREWEBVIEW2_PHYSICAL_KEY_STATUS,
};
use webview2_com::{
    take_pwstr, AcceleratorKeyPressedEventHandler, FocusChangedEventHandler, HistoryChangedEventHandler, SourceChangedEventHandler,
    WindowCloseRequestedEventHandler,
};
use windows::core::PWSTR;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::http::{header, Request, Response, StatusCode};
use wry::{DragDropEvent, NewWindowResponse, Rect, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

use super::{UserEvent, View};
use crate::ipc;
use crate::layout;
use crate::urls::{self, Navigation};

/// night-950, behind both web views until their pages paint.
const NIGHT: (u8, u8, u8, u8) = (0x0b, 0x09, 0x20, 0xff);

/// The terminal page's Content Security Policy: its own scripts and styles only (xterm.js sets
/// inline styles), no network, no frames, no forms.
pub const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

macro_rules! asset {
    ($dir:literal, $file:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/", $dir, "/", $file))
    };
}

/// The files the terminal page loads.
fn asset(path: &str) -> Option<(&'static [u8], &'static str)> {
    Some(match path {
        "/" | "/index.html" => (asset!("web", "index.html"), "text/html; charset=utf-8"),
        "/terminal.js" => (asset!("web", "terminal.js"), "text/javascript; charset=utf-8"),
        "/app.css" => (asset!("web", "app.css"), "text/css; charset=utf-8"),
        "/vendor/xterm.mjs" => (asset!("assets", "xterm.mjs"), "text/javascript; charset=utf-8"),
        "/vendor/xterm.css" => (asset!("assets", "xterm.css"), "text/css; charset=utf-8"),
        "/vendor/addon-fit.mjs" => (asset!("assets", "addon-fit.mjs"), "text/javascript; charset=utf-8"),
        "/vendor/addon-unicode11.mjs" => (asset!("assets", "addon-unicode11.mjs"), "text/javascript; charset=utf-8"),
        "/vendor/addon-webgl.mjs" => (asset!("assets", "addon-webgl.mjs"), "text/javascript; charset=utf-8"),
        _ => return None,
    })
}

fn serve(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let found = (request.method() == "GET").then(|| asset(request.uri().path())).flatten();
    let builder = Response::builder()
        .header(header::CONTENT_SECURITY_POLICY, CSP)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CACHE_CONTROL, "no-store")
        .header("Cross-Origin-Opener-Policy", "same-origin")
        .header(header::REFERRER_POLICY, "no-referrer");
    let response = match found {
        Some((body, mime)) => builder.status(StatusCode::OK).header(header::CONTENT_TYPE, mime).body(Cow::Borrowed(body)),
        None => builder.status(StatusCode::NOT_FOUND).header(header::CONTENT_TYPE, "text/plain").body(Cow::Borrowed(&b"not found"[..])),
    };
    response.unwrap_or_else(|_| Response::new(Cow::Borrowed(&b""[..])))
}

fn send(proxy: &EventLoopProxy<UserEvent>, event: UserEvent) {
    let _ = proxy.send_event(event);
}

fn logical_rect(rect: layout::Rect) -> Rect {
    Rect { position: LogicalPosition::new(rect.x, rect.y).into(), size: LogicalSize::new(rect.width.max(0.0), rect.height.max(0.0)).into() }
}

/// The pane's bounds in wry's terms.
pub fn bounds(rect: layout::Rect) -> Rect {
    logical_rect(rect)
}

/// The terminal's web view: fills the window (wry keeps it sized to it and gives it the focus
/// when the window gets it).
pub fn build_terminal(window: &Window, context: &mut WebContext, proxy: &EventLoopProxy<UserEvent>) -> wry::Result<WebView> {
    let ipc_proxy = proxy.clone();
    let link_proxy = proxy.clone();
    let drop_proxy = proxy.clone();
    let webview = WebViewBuilder::new_with_web_context(context)
        .with_custom_protocol(urls::APP_PROTOCOL.to_string(), |_id, request| serve(request))
        .with_https_scheme(true)
        .with_url(format!("{}://localhost/index.html", urls::APP_PROTOCOL))
        .with_ipc_handler(move |request: Request<String>| {
            // Only the app's own page talks to the host.
            if !urls::is_app_page(&request.uri().to_string()) {
                return;
            }
            if let Some(message) = ipc::parse(request.body()) {
                send(&ipc_proxy, UserEvent::Page(message));
            }
        })
        .with_navigation_handler(|url| urls::is_app_page(&url))
        .with_new_window_req_handler(move |url, _features| {
            if let Some(target) = urls::terminal_link(&url) {
                send(&link_proxy, UserEvent::Link(target));
            }
            NewWindowResponse::Deny
        })
        .with_drag_drop_handler(move |event| {
            if let DragDropEvent::Drop { paths, .. } = event {
                send(&drop_proxy, UserEvent::Dropped(paths.into_iter().collect::<Vec<PathBuf>>()));
            }
            true
        })
        .with_background_color(NIGHT)
        .with_devtools(cfg!(debug_assertions))
        .with_hotkeys_zoom(false)
        .with_back_forward_navigation_gestures(false)
        .with_general_autofill_enabled(false)
        .with_browser_accelerator_keys(false)
        .with_default_context_menus(false)
        .with_theme(wry::Theme::Dark)
        .with_focused(true)
        .build(window)?;
    hook_keys(&webview, View::Terminal, proxy.clone());
    Ok(webview)
}

/// The cloud pane's web view, made the first time the pane opens.
pub fn build_pane(
    window: &Window,
    context: &mut WebContext,
    proxy: &EventLoopProxy<UserEvent>,
    url: &str,
    rect: layout::Rect,
    visible: bool,
) -> wry::Result<WebView> {
    let nav_proxy = proxy.clone();
    let new_window_proxy = proxy.clone();
    let load_proxy = proxy.clone();
    let webview = WebViewBuilder::new_with_web_context(context)
        .with_url(url)
        .with_bounds(logical_rect(rect))
        .with_visible(visible)
        .with_navigation_handler(move |url| match urls::classify_pane_navigation(&url) {
            Navigation::Allow => true,
            Navigation::GoogleSignIn => {
                send(&nav_proxy, UserEvent::PaneNotice(urls::GOOGLE_SIGN_IN_NOTICE.to_string()));
                false
            }
            Navigation::External(url) => {
                super::win::open_in_browser(url);
                false
            }
            Navigation::Refuse => false,
        })
        .with_new_window_req_handler(move |url, _features| {
            match urls::classify_pane_navigation(&url) {
                // A claude.ai page asked for a new tab: it opens in the pane, where the user is
                // signed in.
                Navigation::Allow if url != "about:blank" => send(&new_window_proxy, UserEvent::PaneLoad(url)),
                Navigation::Allow | Navigation::Refuse => {}
                Navigation::GoogleSignIn => send(&new_window_proxy, UserEvent::PaneNotice(urls::GOOGLE_SIGN_IN_NOTICE.to_string())),
                Navigation::External(url) => super::win::open_in_browser(url),
            }
            NewWindowResponse::Deny
        })
        .with_background_color(NIGHT)
        .with_devtools(false)
        .with_hotkeys_zoom(true)
        .with_theme(wry::Theme::Dark)
        .build_as_child(window)?;
    hook_keys(&webview, View::Pane, proxy.clone());
    watch_address(&webview, load_proxy);
    watch_close(&webview, proxy.clone());
    Ok(webview)
}

/// A page in the pane called `window.close()`: wry then destroys the pane's container window
/// (its own handler, which can't be taken off). The window forgets that web view and makes a new
/// one the next time the pane opens, instead of showing an empty frame until it restarts.
fn watch_close(webview: &WebView, proxy: EventLoopProxy<UserEvent>) {
    let closed = WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
        send(&proxy, UserEvent::PaneClosed);
        Ok(())
    }));
    let mut token = 0i64;
    unsafe {
        let _ = webview.webview().add_WindowCloseRequested(&closed, &mut token);
    }
}

/// The pane's address for its header, also when the page changes it without loading (claude.ai
/// is a single-page app). These are WebView2's own events on the host side: nothing runs in the
/// page.
fn watch_address(webview: &WebView, proxy: EventLoopProxy<UserEvent>) {
    let current = |sender: Option<ICoreWebView2>| -> Option<String> {
        let mut uri = PWSTR::null();
        unsafe { sender?.Source(&mut uri).ok()? };
        Some(take_pwstr(uri))
    };
    let source_proxy = proxy.clone();
    let source = SourceChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(url) = current(sender) {
            send(&source_proxy, UserEvent::PaneUrl(url));
        }
        Ok(())
    }));
    let history = HistoryChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(url) = current(sender) {
            send(&proxy, UserEvent::PaneUrl(url));
        }
        Ok(())
    }));
    let core = webview.webview();
    let mut token = 0i64;
    unsafe {
        let _ = core.add_SourceChanged(&source, &mut token);
        let _ = core.add_HistoryChanged(&history, &mut token);
    }
}

/// Ctrl+Shift+K toggles the pane wherever the focus is: the host takes it before either page
/// sees it (so it never reaches lu-minal or claude.ai). And the host learns which of the two
/// web views has the focus, to give it back when the window is activated again.
fn hook_keys(webview: &WebView, view: View, proxy: EventLoopProxy<UserEvent>) {
    let controller = webview.controller();
    let key_proxy = proxy.clone();
    let keys = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
        let mut key = 0u32;
        unsafe {
            args.KeyEventKind(&mut kind)?;
            args.VirtualKey(&mut key)?;
        }
        let down = |vk: u16| unsafe { GetKeyState(i32::from(vk)) } < 0;
        if key == u32::from(b'K') && down(VK_CONTROL.0) && down(VK_SHIFT.0) && !down(VK_MENU.0) {
            unsafe { args.SetHandled(true)? };
            if kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
                unsafe { args.PhysicalKeyStatus(&mut status)? };
                if !status.WasKeyDown.as_bool() {
                    send(&key_proxy, UserEvent::TogglePane);
                }
            }
        }
        Ok(())
    }));
    let focus = FocusChangedEventHandler::create(Box::new(move |_, _| {
        send(&proxy, UserEvent::Focus(view));
        Ok(())
    }));
    let mut token = 0i64;
    unsafe {
        let _ = controller.add_AcceleratorKeyPressed(&keys, &mut token);
        let _ = controller.add_GotFocus(&focus, &mut token);
    }
}

/// Tells the pane's web view that the window moved (its pop-ups, like a select's list, are
/// placed from that); wry does this itself for the terminal's.
pub fn notify_moved(webview: &WebView) {
    unsafe {
        let _ = webview.controller().NotifyParentWindowPositionChanged();
    }
}

/// Whether the pane can go back (for the header's back button).
pub fn can_go_back(webview: &WebView) -> bool {
    webview.can_go_back().unwrap_or(false)
}
