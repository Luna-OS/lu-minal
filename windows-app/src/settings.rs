//! What the window remembers between runs (%LOCALAPPDATA%\lu-minal\window.json): its place and
//! size, whether the cloud pane is open and how wide it is, and the terminal's font size. A file
//! that is missing, unreadable or from another version gives the defaults (the pane closed);
//! out-of-range values are pulled back into range.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::layout;

pub const DEFAULT_FONT_SIZE: f64 = 14.0;
pub const MIN_FONT_SIZE: f64 = 8.0;
pub const MAX_FONT_SIZE: f64 = 32.0;
/// The pane's width the first time it opens (CSS pixels).
pub const DEFAULT_PANE_WIDTH: f64 = 520.0;

/// The window's place: the outer position and the inner size, in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub window: Option<Placement>,
    pub pane_open: bool,
    /// CSS pixels (the terminal page is never zoomed, so these are logical pixels).
    pub pane_width: f64,
    pub font_size: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { window: None, pane_open: false, pane_width: DEFAULT_PANE_WIDTH, font_size: DEFAULT_FONT_SIZE }
    }
}

/// A font size in range, in half points.
pub fn clamp_font_size(size: f64) -> f64 {
    if !size.is_finite() {
        return DEFAULT_FONT_SIZE;
    }
    ((size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE)) * 2.0).round() / 2.0
}

impl Settings {
    /// Pulls every value into its range.
    pub fn sanitized(mut self) -> Self {
        self.font_size = clamp_font_size(self.font_size);
        self.pane_width = if self.pane_width.is_finite() {
            self.pane_width.clamp(layout::PANE_MIN_WIDTH, layout::PANE_MAX_WIDTH).round()
        } else {
            DEFAULT_PANE_WIDTH
        };
        self.window = self.window.filter(|p| {
            (layout::WINDOW_MIN_WIDTH..=layout::WINDOW_MAX_SIDE).contains(&p.width)
                && (layout::WINDOW_MIN_HEIGHT..=layout::WINDOW_MAX_SIDE).contains(&p.height)
                && p.x.unsigned_abs() < layout::WINDOW_MAX_SIDE * 4
                && p.y.unsigned_abs() < layout::WINDOW_MAX_SIDE * 4
        });
        self
    }

    /// Reads the settings, or the defaults when there are none (or they can't be read).
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str::<Settings>(&text).ok()).unwrap_or_default().sanitized()
    }

    /// Writes the settings next to the file and renames them over it, so a crash never leaves
    /// half a file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        text.push('\n');
        let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path).inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lu-minal-window-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_pane_is_closed_by_default() {
        let s = Settings::default();
        assert!(!s.pane_open);
        assert_eq!(s.window, None);
        assert_eq!(s.font_size, DEFAULT_FONT_SIZE);
        assert_eq!(s.pane_width, DEFAULT_PANE_WIDTH);
    }

    #[test]
    fn saves_and_loads_again() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("lu-minal").join("window.json");
        let s = Settings {
            window: Some(Placement { x: -1200, y: 80, width: 1600, height: 900, maximized: true }),
            pane_open: true,
            pane_width: 610.0,
            font_size: 15.5,
        };
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"paneOpen\": true"), "{text}");
        assert!(text.contains("\"fontSize\": 15.5"), "{text}");
        assert_eq!(std::fs::read_dir(path.parent().unwrap()).unwrap().count(), 1, "no temporary file left");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_or_broken_file_gives_the_defaults() {
        let dir = temp_dir("broken");
        assert_eq!(Settings::load(&dir.join("nothing.json")), Settings::default());
        let path = dir.join("window.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(Settings::load(&path), Settings::default());
        std::fs::write(&path, r#"{"paneOpen": true, "somethingNew": [1, 2]}"#).unwrap();
        let s = Settings::load(&path);
        assert!(s.pane_open);
        assert_eq!(s.font_size, DEFAULT_FONT_SIZE);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pulls_values_into_range() {
        let s = Settings {
            window: Some(Placement { x: 0, y: 0, width: 50, height: 900, maximized: false }),
            pane_open: false,
            pane_width: 12.0,
            font_size: 99.0,
        }
        .sanitized();
        assert_eq!(s.window, None, "a window too small to use is forgotten");
        assert_eq!(s.pane_width, layout::PANE_MIN_WIDTH);
        assert_eq!(s.font_size, MAX_FONT_SIZE);
        assert_eq!(clamp_font_size(f64::NAN), DEFAULT_FONT_SIZE);
        assert_eq!(clamp_font_size(13.3), 13.5);
        assert_eq!(clamp_font_size(2.0), MIN_FONT_SIZE);
        let far =
            Settings { window: Some(Placement { x: 900_000, y: 0, width: 800, height: 600, maximized: false }), ..Settings::default() };
        assert_eq!(far.sanitized().window, None);
        let huge = Settings { pane_width: f64::INFINITY, ..Settings::default() };
        assert_eq!(huge.sanitized().pane_width, DEFAULT_PANE_WIDTH);
    }
}
