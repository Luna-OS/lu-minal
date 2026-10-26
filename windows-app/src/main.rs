//! lu-minal-window.exe: lu-minal in a window of its own on Windows, with the Claude Code website
//! (claude.ai/code) in a pane beside the terminal. The terminal is xterm.js in one WebView2, fed
//! by lu-minal running in a ConPTY; the website is the real page in a second WebView2, which the
//! app only shows and keeps on claude.ai (it never scripts the page or reads its data).
//!
//! The pure parts (the OSC filter, the URL rules, settings, layout, the page protocol) build and
//! test on any OS; the window itself (`app`) only on Windows.
// A GUI program (no console window of its own); its unit tests stay a console program.
#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]
#![cfg_attr(not(windows), allow(dead_code))]

mod args;
mod env;
mod ipc;
mod layout;
mod osc;
mod pane;
mod settings;
mod smoke;
mod urls;

#[cfg(windows)]
mod app;

fn main() {
    #[cfg(windows)]
    std::process::exit(app::main());

    #[cfg(not(windows))]
    {
        let args = args::parse(std::env::args().skip(1));
        if args.help {
            println!("{}", args::HELP);
            return;
        }
        eprintln!("lu-minal-window runs on Windows only: it is lu-minal's window there. Run lu-minal in your terminal instead.");
        std::process::exit(1);
    }
}
