//! The environment lu-minal runs with in the window: the shared web pane contract
//! (`LU_MINAL_WEB_PANE=1`), a 256-colour / true-colour terminal named `lu-minal-window`, and
//! nothing left over from the terminal the window was started from. `LU_MINAL_APP` is never set
//! here: lu-minal reads it as "the macOS app".

/// Variables set for lu-minal.
pub fn child_env(version: &str) -> Vec<(String, String)> {
    [
        ("LU_MINAL_WEB_PANE", "1"),
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
        ("TERM_PROGRAM", "lu-minal-window"),
        ("TERM_PROGRAM_VERSION", version),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

/// Variables removed: the macOS app's marker and those of other terminals (Windows Terminal,
/// VS Code, ConEmu, ...), which would make lu-minal think it runs there. The same list as the
/// macOS app's Launcher.swift, plus the Windows ones.
pub const REMOVED_ENV: &[&str] = &[
    "LU_MINAL_APP",
    "TERM_SESSION_ID",
    "ITERM_SESSION_ID",
    "ITERM_PROFILE",
    "WT_SESSION",
    "WT_PROFILE_ID",
    "KITTY_WINDOW_ID",
    "WEZTERM_EXECUTABLE",
    "WEZTERM_PANE",
    "ALACRITTY_WINDOW_ID",
    "GHOSTTY_RESOURCES_DIR",
    "VSCODE_INJECTION",
    "TMUX",
    "TMUX_PANE",
    "STY",
    "ConEmuPID",
    "ConEmuANSI",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_the_web_pane_contract_and_never_the_macos_marker() {
        let env = child_env("0.2.0");
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("LU_MINAL_WEB_PANE"), Some("1"));
        assert_eq!(get("TERM"), Some("xterm-256color"));
        assert_eq!(get("COLORTERM"), Some("truecolor"));
        assert_eq!(get("TERM_PROGRAM"), Some("lu-minal-window"));
        assert_eq!(get("TERM_PROGRAM_VERSION"), Some("0.2.0"));
        assert_eq!(get("LU_MINAL_APP"), None);
        assert!(REMOVED_ENV.contains(&"LU_MINAL_APP"));
        assert!(REMOVED_ENV.contains(&"WT_SESSION"));
        for (key, _) in &env {
            assert!(!REMOVED_ENV.contains(&key.as_str()), "{key} is both set and removed");
        }
    }
}
