//! The messages between the host and the terminal page (web/terminal.js). The page posts JSON
//! (`window.ipc.postMessage`); the host calls `window.lu.<function>(...)` with JSON arguments.
//! Only the terminal's web view has an IPC channel: the cloud pane has none.

use serde::Deserialize;

/// A message from the terminal page.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum PageMessage {
    /// The page's script runs: the host answers with `lu.init(...)`.
    Hello,
    /// xterm.js is open and fitted: start lu-minal with this size.
    Ready {
        cols: u16,
        rows: u16,
    },
    /// Typed text and key sequences (xterm.js onData).
    Input {
        data: String,
    },
    /// Raw bytes, one per character (xterm.js onBinary: old mouse reports).
    Binary {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    /// The terminal's title (OSC 0 / 2).
    Title {
        title: String,
    },
    /// xterm.js has parsed this many bytes of output (flow control).
    Ack {
        bytes: usize,
    },
    /// Where the pane's web view goes, in CSS pixels.
    PaneRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    /// A click in the pane's header, on the divider rail, or Ctrl+Shift+K in the terminal.
    Pane {
        action: PaneButton,
    },
    /// The divider is being dragged (the pane's web view steps aside meanwhile).
    Drag {
        active: bool,
    },
    PaneWidth {
        width: f64,
    },
    FontSize {
        size: f64,
    },
    Copy {
        text: String,
    },
    /// Ctrl+V / right click: the host reads the clipboard.
    Paste,
    /// An OSC 8 link was clicked.
    Link {
        uri: String,
    },
    /// A key after lu-minal ended: close the window.
    Close,
    /// The terminal's text, for the smoke test.
    Smoke {
        text: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PaneButton {
    Toggle,
    Open,
    Close,
    Back,
    Reload,
    Browser,
}

/// Reads a message; `None` for anything the page should not have sent.
pub fn parse(body: &str) -> Option<PageMessage> {
    serde_json::from_str(body).ok()
}

/// The bytes of an onBinary string (each character is one byte; others are dropped).
pub fn binary_bytes(data: &str) -> Vec<u8> {
    data.chars().filter_map(|c| u8::try_from(u32::from(c)).ok()).collect()
}

/// `window.lu.<function>(<args as JSON>)`: a script that can't break out of its call whatever
/// the strings hold.
pub fn call(function: &str, args: &[serde_json::Value]) -> String {
    debug_assert!(function.chars().all(|c| c.is_ascii_alphanumeric()));
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    format!("window.lu&&window.lu.{function}({})", args.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_page_messages() {
        assert_eq!(parse(r#"{"t":"ready","cols":120,"rows":40}"#), Some(PageMessage::Ready { cols: 120, rows: 40 }));
        assert_eq!(parse(r#"{"t":"input","data":"\u001b[A"}"#), Some(PageMessage::Input { data: "\x1b[A".into() }));
        assert_eq!(
            parse(r#"{"t":"pane-rect","x":1080,"y":34,"width":520.5,"height":866}"#),
            Some(PageMessage::PaneRect { x: 1080.0, y: 34.0, width: 520.5, height: 866.0 })
        );
        assert_eq!(parse(r#"{"t":"pane","action":"browser"}"#), Some(PageMessage::Pane { action: PaneButton::Browser }));
        assert_eq!(parse(r#"{"t":"paste"}"#), Some(PageMessage::Paste));
        assert_eq!(parse(r#"{"t":"hello"}"#), Some(PageMessage::Hello));
        assert_eq!(parse(r#"{"t":"ack","bytes":4096}"#), Some(PageMessage::Ack { bytes: 4096 }));
        assert_eq!(parse(r#"{"t":"font-size","size":15}"#), Some(PageMessage::FontSize { size: 15.0 }));
    }

    #[test]
    fn refuses_anything_else() {
        assert_eq!(parse(r#"{"t":"exec","cmd":"calc"}"#), None);
        assert_eq!(parse(r#"{"t":"pane","action":"navigate"}"#), None);
        assert_eq!(parse(r#"{"t":"resize","cols":-1,"rows":5}"#), None);
        assert_eq!(parse("not json"), None);
    }

    #[test]
    fn binary_strings_are_bytes() {
        assert_eq!(binary_bytes("\u{1b}[M \u{ff}!"), vec![0x1b, b'[', b'M', b' ', 0xff, b'!']);
        assert_eq!(binary_bytes("a\u{100}b"), vec![b'a', b'b']);
    }

    #[test]
    fn calls_quote_their_arguments() {
        assert_eq!(call("exited", &[json!(0)]), "window.lu&&window.lu.exited(0)");
        let script = call("paste", &[json!("\");alert(1);//\u{2028}")]);
        assert_eq!(script, r#"window.lu&&window.lu.paste("\");alert(1);// ")"#.replace("\\u2028", "\u{2028}"));
        assert!(script.ends_with("\")"));
    }
}
