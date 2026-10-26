//! The command line: `lu-minal-window.exe [folder] [--smoke[=<file>]] [--smoke-osc[=<file>]]
//! [--program=<lu-minal.exe>]`.

use std::path::PathBuf;

/// What the smoke test checks (CI): the window and both web views come up, and a program's
/// output reaches xterm.js.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SmokeKind {
    /// Runs `lu-minal.exe --version`: its version line must arrive.
    Version,
    /// Runs node printing OSC 7701 sequences: ConPTY must pass them through, the filter take them
    /// out, the URL check refuse the bad one.
    Osc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Smoke {
    pub kind: SmokeKind,
    /// Where the result goes; `None`: the console the app was started from.
    pub out: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Args {
    /// The folder lu-minal starts in (default: the user's profile folder).
    pub folder: Option<PathBuf>,
    pub smoke: Option<Smoke>,
    /// Another lu-minal.exe than the one next to the app (development).
    pub program: Option<PathBuf>,
    pub help: bool,
}

pub const HELP: &str = "lu-minal-window - lu-minal in its own window, with the Claude Code website beside it.

Usage: lu-minal-window.exe [folder] [options]

  folder             where lu-minal starts (default: your user folder)
  --program=<exe>    run this lu-minal.exe instead of the one next to the app
  --smoke[=<file>]   CI: start, run lu-minal.exe --version, print \"smoke ok <version>\", exit
  --smoke-osc[=<file>]  CI: check that OSC 7701 commands reach the window and are taken out
  --help             this text

Keys: Ctrl+Shift+K shows or hides the cloud pane, Ctrl+Shift+C / Ctrl+Shift+V copy and paste,
Ctrl+= / Ctrl+- / Ctrl+0 change the font size.";

fn path_value(value: &str) -> Option<PathBuf> {
    (!value.is_empty()).then(|| PathBuf::from(value))
}

/// Reads the arguments (without the program name). Unknown options are ignored, so a newer
/// shortcut never stops an older app from starting.
pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Args {
    let mut out = Args::default();
    for arg in args {
        let (flag, value) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        match flag.as_str() {
            "--smoke" => out.smoke = Some(Smoke { kind: SmokeKind::Version, out: value.as_deref().and_then(path_value) }),
            "--smoke-osc" => out.smoke = Some(Smoke { kind: SmokeKind::Osc, out: value.as_deref().and_then(path_value) }),
            "--program" => out.program = value.as_deref().and_then(path_value),
            "--help" | "-h" | "/?" => out.help = true,
            _ if arg.starts_with('-') => {}
            _ => {
                if out.folder.is_none() && !arg.is_empty() {
                    out.folder = Some(PathBuf::from(arg));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Args {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn nothing_starts_lu_minal_in_the_user_folder() {
        assert_eq!(p(&[]), Args::default());
    }

    #[test]
    fn a_folder_and_options() {
        let a = p(&["C:\\Users\\ada\\code", "--program=D:\\dist-bin\\lu-minal-windows-x64.exe"]);
        assert_eq!(a.folder, Some(PathBuf::from("C:\\Users\\ada\\code")));
        assert_eq!(a.program, Some(PathBuf::from("D:\\dist-bin\\lu-minal-windows-x64.exe")));
        assert_eq!(a.smoke, None);
    }

    #[test]
    fn smoke_modes() {
        assert_eq!(p(&["--smoke"]).smoke, Some(Smoke { kind: SmokeKind::Version, out: None }));
        assert_eq!(
            p(&["--smoke=C:\\t\\smoke.txt"]).smoke,
            Some(Smoke { kind: SmokeKind::Version, out: Some(PathBuf::from("C:\\t\\smoke.txt")) })
        );
        assert_eq!(p(&["--smoke-osc=out.txt"]).smoke, Some(Smoke { kind: SmokeKind::Osc, out: Some(PathBuf::from("out.txt")) }));
        assert_eq!(p(&["--smoke="]).smoke, Some(Smoke { kind: SmokeKind::Version, out: None }));
    }

    #[test]
    fn unknown_options_are_ignored_and_only_the_first_folder_counts() {
        let a = p(&["--new-thing", "-x", "C:\\a", "C:\\b", "--help"]);
        assert_eq!(a.folder, Some(PathBuf::from("C:\\a")));
        assert!(a.help);
    }
}
