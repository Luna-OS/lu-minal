//! The smoke test's verdict (CI, `--smoke` / `--smoke-osc`): what the terminal showed and which
//! pane commands arrived, against what the program printed.

use crate::args::SmokeKind;
use crate::osc::PaneCommand;

/// How long the smoke test may take before it fails.
pub const TIMEOUT_SECS: u64 = 60;

/// The line node prints for `--smoke-osc`: a refused `open`, a `show`, then a marker.
pub const OSC_SCRIPT: &str = r"process.stdout.write('\x1b]7701;open;https://evil.example/\x07\x1b]7701;show\x1b\\osc-marker\r\n')";

/// The first version number (1.2.3, 0.2.0-rc.1) in the text.
pub fn version_in(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    // A version starts after a space, punctuation or a "v", not inside a word or a number.
    let starts_here = |i: usize| match i.checked_sub(1).map(|p| bytes[p]) {
        None => true,
        Some(b'v' | b'V') => i < 2 || !bytes[i - 2].is_ascii_alphanumeric(),
        Some(p) => !(p.is_ascii_alphanumeric() || p == b'.'),
    };
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && starts_here(i) {
            let start = i;
            let mut parts = 0;
            let mut j = i;
            loop {
                let digits = bytes[j..].iter().take_while(|b| b.is_ascii_digit()).count();
                if digits == 0 {
                    break;
                }
                j += digits;
                parts += 1;
                if j + 1 < bytes.len() && bytes[j] == b'.' && bytes[j + 1].is_ascii_digit() {
                    j += 1;
                } else {
                    break;
                }
            }
            if parts == 3 {
                // A pre-release or build part.
                if j < bytes.len() && (bytes[j] == b'-' || bytes[j] == b'+') {
                    let extra = bytes[j + 1..].iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'.' || **b == b'-').count();
                    if extra > 0 {
                        j += 1 + extra;
                    }
                }
                return Some(text[start..j].trim_end_matches('.').to_string());
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

/// The verdict: `Ok(line)` with the line to print ("smoke ok 0.2.0"), or `Err(reason)`.
pub fn verdict(kind: &SmokeKind, text: &str, commands: &[PaneCommand], exit_code: Option<u32>) -> Result<String, String> {
    match kind {
        SmokeKind::Version => {
            if exit_code != Some(0) {
                return Err(format!("lu-minal.exe --version exited with {exit_code:?}; the terminal showed: {:?}", text.trim()));
            }
            version_in(text)
                .map(|v| format!("smoke ok {v}"))
                .ok_or_else(|| format!("no version line reached the terminal; it showed: {:?}", text.trim()))
        }
        SmokeKind::Osc => {
            if !text.contains("osc-marker") {
                return Err(format!("the program's output did not reach the terminal; it showed: {:?}", text.trim()));
            }
            if text.contains("7701") || text.contains("evil") {
                return Err(format!("an OSC 7701 sequence reached the terminal: {:?}", text.trim()));
            }
            if commands != [PaneCommand::Show] {
                return Err(format!("expected exactly the show command, got {commands:?}"));
            }
            Ok("smoke ok osc".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_version() {
        assert_eq!(version_in("lu-minal 0.1.4\r\n").as_deref(), Some("0.1.4"));
        assert_eq!(version_in("0.2.0-rc.1").as_deref(), Some("0.2.0-rc.1"));
        assert_eq!(version_in("v1.10.300+5 more").as_deref(), Some("1.10.300+5"));
        assert_eq!(version_in("build 10.0.22631.4317 then 0.3.0").as_deref(), Some("0.3.0"));
        assert_eq!(version_in("1.2 and 3.4").as_deref(), None);
        assert_eq!(version_in("ends with 1.2.").as_deref(), None);
        assert_eq!(version_in("x1.2.3"), None);
        assert_eq!(version_in("").as_deref(), None);
    }

    #[test]
    fn the_version_verdict() {
        assert_eq!(verdict(&SmokeKind::Version, "0.1.4\r\n", &[], Some(0)), Ok("smoke ok 0.1.4".into()));
        assert!(verdict(&SmokeKind::Version, "0.1.4", &[], Some(1)).is_err());
        assert!(verdict(&SmokeKind::Version, "", &[], Some(0)).unwrap_err().contains("no version line"));
    }

    #[test]
    fn the_osc_verdict() {
        assert_eq!(verdict(&SmokeKind::Osc, "osc-marker\r\n", &[PaneCommand::Show], Some(0)), Ok("smoke ok osc".into()));
        assert!(verdict(&SmokeKind::Osc, "]7701;show osc-marker", &[PaneCommand::Show], Some(0)).is_err());
        assert!(verdict(&SmokeKind::Osc, "osc-marker", &[], Some(0)).is_err());
        assert!(verdict(&SmokeKind::Osc, "osc-marker", &[PaneCommand::Open("https://evil.example/".into()), PaneCommand::Show], Some(0))
            .is_err());
        assert!(verdict(&SmokeKind::Osc, "", &[PaneCommand::Show], Some(0)).is_err());
    }

    #[test]
    fn the_osc_script_prints_what_the_filter_expects() {
        // The script's string, as node unescapes it.
        let printed = OSC_SCRIPT
            .trim_start_matches("process.stdout.write('")
            .trim_end_matches("')")
            .replace("\\x1b", "\x1b")
            .replace("\\x07", "\x07")
            .replace("\\\\", "\\")
            .replace("\\r", "\r")
            .replace("\\n", "\n");
        let mut filter = crate::osc::OscFilter::new();
        let (mut out, mut commands) = (Vec::new(), Vec::new());
        filter.feed(printed.as_bytes(), &mut out, &mut commands);
        assert_eq!(String::from_utf8(out).unwrap(), "osc-marker\r\n");
        assert_eq!(verdict(&SmokeKind::Osc, "osc-marker", &commands, Some(0)), Ok("smoke ok osc".into()));
    }
}
