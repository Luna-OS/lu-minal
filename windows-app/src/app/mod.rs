//! The window: tao's event loop, the terminal's web view filling the window, the cloud pane's
//! web view over the right part of it (where the terminal page leaves room under the pane's
//! header), lu-minal in a ConPTY, and what remains between runs.

mod pty;
mod web;
mod win;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use serde_json::json;
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::{IconExtWindows, WindowExtWindows};
use tao::window::{Icon, Theme, Window, WindowBuilder};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    IDNO, IDYES, MB_DEFBUTTON2, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_ICONWARNING, MB_OK, MB_YESNO, MB_YESNOCANCEL,
};
use wry::{WebContext, WebView, WebViewExtWindows};

use crate::args::{self, SmokeKind};
use crate::env;
use crate::ipc::{self, PageMessage, PaneButton};
use crate::layout::{self, Rect};
use crate::osc::PaneCommand;
use crate::pane::{Pane, PaneAction};
use crate::settings::{self, Placement, Settings};
use crate::smoke;
use crate::urls::{self, LinkTarget};
use pty::{Launch, PtyEvent, Session};

/// The app's version (the repository's package.json, through build.rs).
pub const VERSION: &str = env!("LU_MINAL_WINDOW_VERSION");

const WEBVIEW2_DOWNLOAD: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

/// Which web view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Terminal,
    Pane,
}

/// What reaches the event loop from the web views' handlers and the PTY threads.
#[derive(Debug)]
pub enum UserEvent {
    Page(PageMessage),
    Pty(PtyEvent),
    TogglePane,
    Focus(View),
    PaneNotice(String),
    PaneLoad(String),
    PaneUrl(String),
    /// A page in the pane closed it (`window.close()`).
    PaneClosed,
    Link(LinkTarget),
    Dropped(Vec<PathBuf>),
    SmokeTimeout,
    ShutdownTimeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Run {
    /// Waiting for the terminal page.
    Starting,
    Running,
    /// lu-minal ended; a key closes the window.
    Ended,
    /// The window is closing: lu-minal was asked to end.
    ShuttingDown,
}

struct SmokeRun {
    kind: SmokeKind,
    out: Option<PathBuf>,
    commands: Vec<PaneCommand>,
    exit_code: Option<u32>,
    /// How far it got, for the reason when it times out.
    stage: &'static str,
}

struct App {
    window: Window,
    proxy: EventLoopProxy<UserEvent>,
    context: WebContext,
    terminal: WebView,
    pane_view: Option<WebView>,
    /// Pane web views a page closed. Kept, not dropped, while the window runs: dropping a wry
    /// (0.57) child web view also unhooks the terminal's web view from the window's resizing.
    closed_panes: Vec<WebView>,
    pane: Pane,
    /// Where the pane's web view is (logical pixels).
    pane_rect: Rect,
    /// The window's inner size (logical pixels).
    size: (f64, f64),
    dragging: bool,
    pane_focused: bool,
    run: Run,
    session: Option<Session>,
    launch: Launch,
    settings: Settings,
    settings_path: PathBuf,
    /// The last place the window had while it was neither maximized nor minimized.
    normal: Option<Placement>,
    smoke: Option<SmokeRun>,
    /// What `lu.init` gets when the page says hello.
    init: serde_json::Value,
    exit: Option<i32>,
}

fn hwnd(window: &Window) -> HWND {
    HWND(window.hwnd() as _)
}

/// Quotes a dropped path the way a shell takes it.
fn quote_path(path: &Path) -> String {
    let text = path.display().to_string();
    if text.contains([' ', '&', '(', ')', '\'', '^', ';', ',']) {
        format!("\"{text}\"")
    } else {
        text
    }
}

impl App {
    /// Runs `window.lu.<function>(...)` in the terminal page.
    fn call(&self, function: &str, args: &[serde_json::Value]) {
        let _ = self.terminal.evaluate_script(&ipc::call(function, args));
    }

    fn save_settings(&mut self) {
        if self.smoke.is_some() {
            return;
        }
        if let Some(normal) = self.normal {
            self.settings.window = Some(Placement { maximized: self.window.is_maximized(), ..normal });
        }
        let _ = self.settings.clone().sanitized().save(&self.settings_path);
    }

    fn remember_placement(&mut self) {
        if self.window.is_maximized() || self.window.is_minimized() {
            return;
        }
        let size = self.window.inner_size();
        if size.width == 0 || size.height == 0 {
            return;
        }
        if let Ok(pos) = self.window.outer_position() {
            self.normal = Some(Placement { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized: false });
        }
    }

    fn logical_size(&self) -> (f64, f64) {
        let size: LogicalSize<f64> = self.window.inner_size().to_logical(self.window.scale_factor());
        (size.width, size.height)
    }

    // ---- lu-minal ---------------------------------------------------------------------------

    fn start_session(&mut self, cols: u16, rows: u16) {
        if self.run != Run::Starting {
            return;
        }
        match Session::start(&self.launch, cols, rows, self.proxy.clone()) {
            Ok(session) => {
                self.session = Some(session);
                self.run = Run::Running;
            }
            Err(error) => {
                self.run = Run::Ended;
                if let Some(smoke) = &self.smoke {
                    let out = smoke.out.clone();
                    self.finish_smoke(Err(error), out);
                    return;
                }
                let text = format!("\r\n\x1b[38;2;242;139;146m{error}\x1b[0m\r\n");
                self.call("output", &[json!(base64::engine::general_purpose::STANDARD.encode(text.as_bytes())), json!(0)]);
                self.call("exited", &[serde_json::Value::Null]);
            }
        }
    }

    fn on_pty(&mut self, event: PtyEvent) {
        match event {
            PtyEvent::Output(bytes) => {
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                self.call("output", &[json!(encoded), json!(bytes.len())]);
            }
            PtyEvent::Command(command) => match &mut self.smoke {
                // The smoke test only records them (the pane would load claude.ai).
                Some(smoke) => smoke.commands.push(command),
                None => self.pane_command(&command),
            },
            PtyEvent::Exited(code) => {
                self.session = None;
                if let Some(smoke) = &mut self.smoke {
                    smoke.exit_code = code;
                    smoke.stage = "the program ended, but the terminal page never sent its text";
                    self.call("smokeCollect", &[]);
                    return;
                }
                if self.run == Run::ShuttingDown {
                    self.quit(0);
                    return;
                }
                self.run = Run::Ended;
                self.call("exited", &[code.map_or(serde_json::Value::Null, |c| json!(c))]);
            }
        }
    }

    // ---- the cloud pane -----------------------------------------------------------------------

    fn pane_command(&mut self, command: &PaneCommand) {
        for action in self.pane.apply(command) {
            match action {
                PaneAction::Create(url) => {
                    let (w, h) = self.size;
                    self.pane_rect = layout::pane_rect(w, h, self.settings.pane_width);
                    match web::build_pane(&self.window, &mut self.context, &self.proxy, &url, self.pane_rect, false) {
                        Ok(view) => {
                            win::clip_siblings(&[self.terminal.hwnd(), view.hwnd()], Some(view.hwnd()));
                            self.pane_view = Some(view);
                        }
                        Err(error) => {
                            self.pane = Pane::new();
                            self.call("notice", &[json!(format!("The cloud pane could not start: {error}"))]);
                            return;
                        }
                    }
                }
                PaneAction::Load(url) => {
                    if let Some(view) = &self.pane_view {
                        let _ = view.load_url(&url);
                    }
                }
                PaneAction::Show => {
                    if let Some(view) = &self.pane_view {
                        let _ = view.set_bounds(web::bounds(self.pane_rect));
                        let _ = view.set_visible(true);
                    }
                    self.settings.pane_open = true;
                    self.call("setPane", &[json!(true), json!(self.settings.pane_width)]);
                    self.save_settings();
                }
                PaneAction::Hide => {
                    if let Some(view) = &self.pane_view {
                        let _ = view.set_visible(false);
                    }
                    self.settings.pane_open = false;
                    self.pane_focused = false;
                    self.call("setPane", &[json!(false), json!(self.settings.pane_width)]);
                    let _ = self.terminal.focus();
                    self.save_settings();
                }
            }
        }
    }

    fn pane_button(&mut self, button: PaneButton) {
        match button {
            PaneButton::Toggle => self.pane_command(&PaneCommand::Toggle),
            PaneButton::Open => self.pane_command(&PaneCommand::Show),
            PaneButton::Close => self.pane_command(&PaneCommand::Hide),
            PaneButton::Back => {
                if let Some(view) = &self.pane_view {
                    let _ = view.go_back();
                }
            }
            PaneButton::Reload => {
                if let Some(view) = &self.pane_view {
                    let _ = view.reload();
                }
            }
            PaneButton::Browser => {
                let url = self.pane_view.as_ref().and_then(|v| v.url().ok()).unwrap_or_else(|| urls::PANE_HOME.to_string());
                if let Some(url) = urls::external_url(&url) {
                    win::open_in_browser(url);
                }
            }
        }
    }

    fn place_pane(&self) {
        if let (Some(view), true, false) = (&self.pane_view, self.pane.open, self.dragging) {
            let _ = view.set_bounds(web::bounds(self.pane_rect));
        }
    }

    // ---- the terminal page --------------------------------------------------------------------

    fn on_page(&mut self, message: PageMessage) {
        if let Some(smoke) = &mut self.smoke {
            match message {
                PageMessage::Hello => smoke.stage = "the terminal page loaded, but xterm.js never opened",
                PageMessage::Ready { .. } => smoke.stage = "xterm.js opened, but the program never ended",
                _ => {}
            }
        }
        match message {
            PageMessage::Hello => self.call("init", std::slice::from_ref(&self.init)),
            PageMessage::Ready { cols, rows } => {
                if self.smoke.is_some() {
                    // Both web views exist in the smoke test; the pane stays hidden and empty.
                    let (w, h) = self.size;
                    self.pane_rect = layout::pane_rect(w, h, self.settings.pane_width);
                    match web::build_pane(&self.window, &mut self.context, &self.proxy, "about:blank", self.pane_rect, false) {
                        Ok(view) => {
                            win::clip_siblings(&[self.terminal.hwnd(), view.hwnd()], Some(view.hwnd()));
                            self.pane_view = Some(view);
                        }
                        Err(error) => {
                            let out = self.smoke.as_ref().and_then(|s| s.out.clone());
                            self.finish_smoke(Err(format!("the pane's web view could not be created: {error}")), out);
                            return;
                        }
                    }
                }
                self.start_session(cols, rows);
                if self.smoke.is_none() && self.settings.pane_open {
                    self.pane_command(&PaneCommand::Show);
                }
            }
            PageMessage::Input { data } => {
                if let Some(session) = &self.session {
                    session.write(data.into_bytes());
                }
            }
            PageMessage::Binary { data } => {
                if let Some(session) = &self.session {
                    session.write(ipc::binary_bytes(&data));
                }
            }
            PageMessage::Resize { cols, rows } => {
                if let Some(session) = &self.session {
                    session.resize(cols, rows);
                }
            }
            PageMessage::Title { title } => {
                let title = title.trim();
                self.window.set_title(if title.is_empty() { "lu-minal" } else { title });
            }
            PageMessage::Ack { bytes } => {
                if let Some(session) = &self.session {
                    session.acknowledged(bytes);
                }
            }
            PageMessage::PaneRect { x, y, width, height } => {
                let rect = Rect::new(x, y, width, height);
                if rect.is_sane() {
                    self.pane_rect = rect;
                    self.place_pane();
                }
            }
            PageMessage::Pane { action } => self.pane_button(action),
            PageMessage::Drag { active } => {
                self.dragging = active;
                if let (Some(view), true) = (&self.pane_view, self.pane.open) {
                    if !active {
                        let _ = view.set_bounds(web::bounds(self.pane_rect));
                    }
                    let _ = view.set_visible(!active);
                }
                if !active {
                    self.save_settings();
                }
            }
            PageMessage::PaneWidth { width } => {
                if width.is_finite() {
                    self.settings.pane_width = width.clamp(layout::PANE_MIN_WIDTH, layout::PANE_MAX_WIDTH).round();
                }
            }
            PageMessage::FontSize { size } => {
                self.settings.font_size = settings::clamp_font_size(size);
                self.save_settings();
            }
            PageMessage::Copy { text } => {
                win::set_clipboard_text(Some(hwnd(&self.window)), &text);
            }
            PageMessage::Paste => match win::clipboard_text(Some(hwnd(&self.window))) {
                Some(text) if !text.is_empty() => self.call("paste", &[json!(text)]),
                // A picture or files copied in Explorer: an empty bracketed paste, on which
                // lu-minal reads the clipboard itself.
                _ => self.call("pasteEmpty", &[]),
            },
            PageMessage::Link { uri } => {
                if let Some(target) = urls::terminal_link(&uri) {
                    self.on_link(target);
                }
            }
            PageMessage::Close => {
                if self.run == Run::Ended {
                    self.quit(0);
                }
            }
            PageMessage::Smoke { text } => {
                if let Some(smoke) = &self.smoke {
                    let verdict = smoke::verdict(&smoke.kind, &text, &smoke.commands, smoke.exit_code);
                    let out = smoke.out.clone();
                    self.finish_smoke(verdict, out);
                }
            }
        }
    }

    fn on_link(&mut self, target: LinkTarget) {
        match target {
            LinkTarget::Pane(url) => self.pane_command(&PaneCommand::Open(url)),
            LinkTarget::Browser(url) => win::open_in_browser(url),
        }
    }

    // ---- the window ---------------------------------------------------------------------------

    fn on_window(&mut self, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => self.request_close(),
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                let new = self.logical_size();
                if new.0 > 0.0 && new.1 > 0.0 {
                    if self.pane.open && !self.dragging {
                        self.pane_rect = layout::anchor_pane(self.pane_rect, self.size, new);
                        self.place_pane();
                    }
                    self.size = new;
                }
                self.remember_placement();
            }
            WindowEvent::Moved(_) => {
                if let Some(view) = &self.pane_view {
                    web::notify_moved(view);
                }
                self.remember_placement();
            }
            // wry gives the terminal the focus when the window gets it; the pane gets it back
            // when it had it.
            WindowEvent::Focused(true) => {
                if let (Some(view), true) = (&self.pane_view, self.pane.open && self.pane_focused) {
                    let _ = view.focus();
                }
            }
            _ => {}
        }
    }

    fn request_close(&mut self) {
        if let Some(smoke) = &self.smoke {
            let out = smoke.out.clone();
            self.finish_smoke(Err("the window was closed".into()), out);
            return;
        }
        match self.run {
            Run::Running => {
                let answer = win::message_box(
                    Some(hwnd(&self.window)),
                    "lu-minal is still running in this window.\n\nClose the window and end lu-minal? Your tabs come back the next time you start it.",
                    "lu-minal",
                    MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2,
                );
                if answer != IDYES {
                    return;
                }
                self.run = Run::ShuttingDown;
                self.save_settings();
                self.window.set_title("lu-minal - closing...");
                if let Some(session) = &self.session {
                    session.hang_up();
                }
                let proxy = self.proxy.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(5));
                    let _ = proxy.send_event(UserEvent::ShutdownTimeout);
                });
            }
            Run::ShuttingDown => {}
            Run::Starting | Run::Ended => self.quit(0),
        }
    }

    fn quit(&mut self, code: i32) {
        self.save_settings();
        if let Some(mut session) = self.session.take() {
            session.kill();
        }
        self.exit = Some(code);
    }

    fn finish_smoke(&mut self, verdict: Result<String, String>, out: Option<PathBuf>) {
        let (line, code) = match verdict {
            Ok(line) => (line, 0),
            Err(reason) => (format!("smoke failed: {reason}"), 1),
        };
        win::smoke_output(out.as_deref(), &line);
        // Still a smoke run while quitting: it leaves the user's window.json alone.
        self.quit(code);
        self.smoke = None;
    }

    fn on_user(&mut self, event: UserEvent) {
        match event {
            UserEvent::Page(message) => self.on_page(message),
            UserEvent::Pty(event) => self.on_pty(event),
            UserEvent::TogglePane => {
                if self.smoke.is_none() {
                    self.pane_command(&PaneCommand::Toggle);
                }
            }
            UserEvent::Focus(view) => self.pane_focused = view == View::Pane,
            UserEvent::PaneNotice(text) => self.call("notice", &[json!(text)]),
            UserEvent::PaneLoad(url) => {
                if let Some(view) = &self.pane_view {
                    let _ = view.load_url(&url);
                }
            }
            UserEvent::PaneUrl(url) => {
                let back = self.pane_view.as_ref().is_some_and(web::can_go_back);
                self.call("paneUrl", &[json!(urls::display_url(&url)), json!(back)]);
            }
            UserEvent::PaneClosed => {
                let Some(view) = self.pane_view.take() else { return };
                let _ = view.set_visible(false);
                self.closed_panes.push(view);
                let was_open = self.pane.open;
                // Not created any more: the next show makes a new web view on claude.ai/code.
                self.pane = Pane::new();
                self.pane_focused = false;
                if was_open {
                    self.settings.pane_open = false;
                    self.call("setPane", &[json!(false), json!(self.settings.pane_width)]);
                    let _ = self.terminal.focus();
                    self.save_settings();
                }
            }
            UserEvent::Link(target) => self.on_link(target),
            UserEvent::Dropped(paths) => {
                if self.run == Run::Running && !paths.is_empty() {
                    let text = paths.iter().map(|p| quote_path(p)).collect::<Vec<_>>().join(" ");
                    self.call("paste", &[json!(text)]);
                }
            }
            UserEvent::SmokeTimeout => {
                if let Some(smoke) = &self.smoke {
                    let out = smoke.out.clone();
                    self.finish_smoke(Err(format!("no result after {} s: {}", smoke::TIMEOUT_SECS, smoke.stage)), out);
                }
            }
            UserEvent::ShutdownTimeout => {
                if self.run == Run::ShuttingDown {
                    self.quit(0);
                }
            }
        }
    }
}

/// No WebView2 runtime (rare on Windows 10): explain, and offer lu-minal in a console window.
fn no_webview2(program: &Path, cwd: &Path) -> i32 {
    let answer = win::message_box(
        None,
        &format!(
            "lu-minal's window needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC.\n\n\
             Yes: open the download page ({WEBVIEW2_DOWNLOAD}), install it, then start lu-minal again.\n\
             No: start lu-minal in a console window instead (without the cloud pane)."
        ),
        "lu-minal",
        MB_YESNOCANCEL | MB_ICONWARNING,
    );
    if answer == IDYES {
        win::open_in_browser(WEBVIEW2_DOWNLOAD.to_string());
        // Give the browser a moment to start before this process ends.
        std::thread::sleep(Duration::from_secs(2));
    } else if answer == IDNO {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let mut cmd = std::process::Command::new(program);
        cmd.current_dir(cwd).creation_flags(CREATE_NEW_CONSOLE);
        for key in env::REMOVED_ENV {
            cmd.env_remove(key);
        }
        // A console has no web pane: nothing of the window's contract may come along (when this
        // window was started from inside another lu-minal window).
        for (key, _) in env::child_env(VERSION) {
            cmd.env_remove(key);
        }
        if let Err(error) = cmd.spawn() {
            win::message_box(None, &format!("Could not start {}: {error}", program.display()), "lu-minal", MB_OK | MB_ICONERROR);
            return 1;
        }
    }
    0
}

fn fail(smoke: Option<&args::Smoke>, message: &str) -> i32 {
    match smoke {
        Some(smoke) => win::smoke_output(smoke.out.as_deref(), &format!("smoke failed: {message}")),
        None => {
            win::message_box(None, message, "lu-minal", MB_OK | MB_ICONERROR);
        }
    }
    1
}

pub fn main() -> i32 {
    let args = args::parse(std::env::args().skip(1));
    if args.help {
        win::message_box(None, args::HELP, "lu-minal", MB_OK | MB_ICONINFORMATION);
        return 0;
    }
    let smoke = args.smoke.clone();

    let here = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    let program = args.program.clone().unwrap_or_else(|| here.join("lu-minal.exe"));
    if !program.is_file() {
        return fail(
            smoke.as_ref(),
            &format!(
                "lu-minal.exe is missing: it belongs next to lu-minal-window.exe, in {}.\n\nInstall lu-minal again to repair it.",
                here.display()
            ),
        );
    }
    let cwd = args.folder.clone().filter(|f| f.is_dir()).unwrap_or_else(win::home_dir);

    if let Err(error) = win::webview2_version() {
        if smoke.is_some() {
            return fail(smoke.as_ref(), &format!("no WebView2 runtime: {error}"));
        }
        return no_webview2(&program, &cwd);
    }

    let data = win::data_dir();
    let settings_path = data.join("window.json");
    let settings = Settings::load(&settings_path);

    let (launch_program, launch_args): (PathBuf, Vec<OsString>) = match smoke.as_ref().map(|s| &s.kind) {
        Some(SmokeKind::Version) => (program.clone(), vec!["--version".into()]),
        Some(SmokeKind::Osc) => match win::find_on_path("node.exe") {
            Some(node) => (node, vec!["-e".into(), smoke::OSC_SCRIPT.into()]),
            None => return fail(smoke.as_ref(), "node.exe is not on the PATH (the OSC smoke test runs it)"),
        },
        None => (program.clone(), Vec::new()),
    };
    let launch = Launch {
        program: launch_program,
        args: launch_args,
        cwd: cwd.clone(),
        set_env: env::child_env(VERSION),
        remove_env: env::REMOVED_ENV.to_vec(),
    };

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let mut builder = WindowBuilder::new()
        .with_title("lu-minal")
        .with_theme(Some(Theme::Dark))
        .with_background_color((0x0b, 0x09, 0x20, 0xff))
        .with_min_inner_size(LogicalSize::new(f64::from(layout::WINDOW_MIN_WIDTH), f64::from(layout::WINDOW_MIN_HEIGHT)))
        .with_inner_size(LogicalSize::new(1280.0, 800.0));
    if let Ok(icon) = Icon::from_resource(1, None) {
        builder = builder.with_window_icon(Some(icon));
    }
    if let Some(place) = settings.window {
        let screens: Vec<Rect> = event_loop
            .available_monitors()
            .map(|m| Rect::new(f64::from(m.position().x), f64::from(m.position().y), f64::from(m.size().width), f64::from(m.size().height)))
            .collect();
        if layout::placement_visible(
            Rect::new(f64::from(place.x), f64::from(place.y), f64::from(place.width), f64::from(place.height)),
            &screens,
        ) {
            builder = builder
                .with_position(PhysicalPosition::new(place.x, place.y))
                .with_inner_size(PhysicalSize::new(place.width, place.height))
                .with_maximized(place.maximized && smoke.is_none());
        }
    }
    let window = match builder.build(&event_loop) {
        Ok(window) => window,
        Err(error) => return fail(smoke.as_ref(), &format!("Could not open the window: {error}")),
    };

    let mut context = WebContext::new(Some(data.join("WebView2")));
    let terminal = match web::build_terminal(&window, &mut context, &proxy) {
        Ok(view) => view,
        Err(error) => return fail(smoke.as_ref(), &format!("Could not start the terminal's web view (WebView2): {error}")),
    };

    let init = json!({
        "fontSize": settings.font_size,
        "paneWidth": settings.pane_width,
        "windowsBuild": win::windows_build(),
        "version": VERSION,
        "smoke": smoke.is_some(),
    });

    if smoke.is_some() {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(smoke::TIMEOUT_SECS));
            let _ = proxy.send_event(UserEvent::SmokeTimeout);
        });
    }

    let mut app = App {
        size: (0.0, 0.0),
        window,
        proxy,
        context,
        terminal,
        pane_view: None,
        closed_panes: Vec::new(),
        pane: Pane::new(),
        pane_rect: Rect::new(0.0, layout::HEADER_HEIGHT, 0.0, 0.0),
        dragging: false,
        pane_focused: false,
        run: Run::Starting,
        session: None,
        launch,
        settings,
        settings_path,
        normal: None,
        smoke: smoke.map(|s| SmokeRun {
            kind: s.kind,
            out: s.out,
            commands: Vec::new(),
            exit_code: None,
            stage: "the terminal page never loaded",
        }),
        init,
        exit: None,
    };
    app.size = app.logical_size();
    app.remember_placement();

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event, .. } => app.on_window(event),
            Event::UserEvent(event) => app.on_user(event),
            _ => {}
        }
        if let Some(code) = app.exit {
            *control_flow = ControlFlow::ExitWithCode(code);
        }
    })
}
