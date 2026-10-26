//! The window's layout: the terminal on the left, the divider, the cloud pane on the right with
//! its header on top. The terminal page lays this out in HTML and reports where the pane's web
//! view goes; the host keeps it in place while the window is resized (anchored right and
//! bottom) until the page reports again, and checks that a remembered window is on a screen.
//! The same limits are in web/terminal.js.

/// The narrowest the pane gets (CSS pixels).
pub const PANE_MIN_WIDTH: f64 = 300.0;
/// The widest a remembered pane width can be.
pub const PANE_MAX_WIDTH: f64 = 4000.0;
/// What the terminal keeps at least, next to an open pane.
pub const TERMINAL_MIN_WIDTH: f64 = 320.0;
/// The divider between the terminal and the pane.
pub const DIVIDER_WIDTH: f64 = 6.0;
/// The pane's header (back, reload, open in browser, close).
pub const HEADER_HEIGHT: f64 = 34.0;

pub const WINDOW_MIN_WIDTH: u32 = 480;
pub const WINDOW_MIN_HEIGHT: u32 = 320;
pub const WINDOW_MAX_SIDE: u32 = 32_768;

/// A rectangle in logical (CSS) or physical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    fn intersection(&self, other: &Rect) -> Option<Rect> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = (self.x + self.width).min(other.x + other.width);
        let bottom = (self.y + self.height).min(other.y + other.height);
        (right > x && bottom > y).then(|| Rect::new(x, y, right - x, bottom - y))
    }

    /// Finite, not negative in size: something the page may report.
    pub fn is_sane(&self) -> bool {
        [self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite() && v.abs() < 1e6) && self.width >= 0.0 && self.height >= 0.0
    }
}

/// The pane's width in a window this wide: its wish, but leaving the terminal its minimum (and
/// at least half the window when the window is too narrow for both minimums).
pub fn clamp_pane_width(wish: f64, window_width: f64) -> f64 {
    let wish = if wish.is_finite() { wish } else { PANE_MIN_WIDTH };
    let room = window_width - TERMINAL_MIN_WIDTH - DIVIDER_WIDTH;
    let max = if room >= PANE_MIN_WIDTH { room } else { (window_width / 2.0).max(0.0) };
    let min = PANE_MIN_WIDTH.min(max);
    wish.clamp(min, max).round()
}

/// Where the pane's web view goes in a window of this logical size (below the header, at the
/// right edge), before the page has said so itself.
pub fn pane_rect(window_width: f64, window_height: f64, pane_width: f64) -> Rect {
    let width = clamp_pane_width(pane_width, window_width);
    Rect::new((window_width - width).max(0.0), HEADER_HEIGHT, width, (window_height - HEADER_HEIGHT).max(0.0))
}

/// Keeps the pane where it was relative to the right and bottom edges while the window goes from
/// `old` to `new` (width, height): the page reports the exact place once it has laid out again.
pub fn anchor_pane(pane: Rect, old: (f64, f64), new: (f64, f64)) -> Rect {
    let right_gap = (old.0 - (pane.x + pane.width)).max(0.0);
    let bottom_gap = (old.1 - (pane.y + pane.height)).max(0.0);
    let width = pane.width.min((new.0 - right_gap).max(0.0));
    let x = (new.0 - right_gap - width).max(0.0);
    let height = (new.1 - bottom_gap - pane.y).max(0.0);
    Rect::new(x, pane.y, width, height)
}

/// Whether a remembered window would be reachable: enough of its top edge (where it is dragged)
/// on one of the screens' work areas.
pub fn placement_visible(window: Rect, screens: &[Rect]) -> bool {
    let grip = Rect::new(window.x, window.y, window.width, 32.0_f64.min(window.height));
    screens
        .iter()
        .filter_map(|s| grip.intersection(s))
        .any(|r| r.width >= 120.0_f64.min(window.width) && r.height >= 16.0_f64.min(grip.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pane_leaves_the_terminal_room() {
        assert_eq!(clamp_pane_width(520.0, 1600.0), 520.0);
        assert_eq!(clamp_pane_width(1500.0, 1600.0), 1600.0 - TERMINAL_MIN_WIDTH - DIVIDER_WIDTH);
        assert_eq!(clamp_pane_width(10.0, 1600.0), PANE_MIN_WIDTH);
        // Too narrow for both minimums: half each.
        assert_eq!(clamp_pane_width(520.0, 500.0), 250.0);
        assert_eq!(clamp_pane_width(100.0, 500.0), 250.0);
        assert_eq!(clamp_pane_width(f64::NAN, 1600.0), PANE_MIN_WIDTH);
        assert_eq!(clamp_pane_width(400.0, 0.0), 0.0);
    }

    #[test]
    fn the_pane_sits_at_the_right_below_its_header() {
        assert_eq!(pane_rect(1600.0, 900.0, 520.0), Rect::new(1080.0, HEADER_HEIGHT, 520.0, 900.0 - HEADER_HEIGHT));
        let narrow = pane_rect(500.0, 20.0, 520.0);
        assert_eq!(narrow.x, 250.0);
        assert_eq!(narrow.height, 0.0);
    }

    #[test]
    fn anchors_the_pane_right_and_bottom_while_resizing() {
        let pane = Rect::new(1080.0, 34.0, 520.0, 866.0);
        assert_eq!(anchor_pane(pane, (1600.0, 900.0), (1800.0, 1000.0)), Rect::new(1280.0, 34.0, 520.0, 966.0));
        assert_eq!(anchor_pane(pane, (1600.0, 900.0), (1200.0, 700.0)), Rect::new(680.0, 34.0, 520.0, 666.0));
        // Narrower than the pane: it shrinks instead of leaving the window.
        assert_eq!(anchor_pane(pane, (1600.0, 900.0), (300.0, 900.0)), Rect::new(0.0, 34.0, 300.0, 866.0));
        // A notice under the header (pane further down) and a gap at the bottom are kept.
        let lower = Rect::new(1080.0, 70.0, 520.0, 820.0);
        assert_eq!(anchor_pane(lower, (1600.0, 900.0), (1600.0, 800.0)), Rect::new(1080.0, 70.0, 520.0, 720.0));
    }

    #[test]
    fn a_remembered_window_must_be_on_a_screen() {
        let screens = [Rect::new(0.0, 0.0, 1920.0, 1040.0), Rect::new(1920.0, -200.0, 2560.0, 1400.0)];
        assert!(placement_visible(Rect::new(100.0, 100.0, 1200.0, 800.0), &screens));
        assert!(placement_visible(Rect::new(3000.0, -150.0, 1200.0, 800.0), &screens), "on the second screen");
        assert!(placement_visible(Rect::new(1800.0, 10.0, 600.0, 400.0), &screens), "across both");
        assert!(!placement_visible(Rect::new(5000.0, 100.0, 1200.0, 800.0), &screens), "the screen it was on is gone");
        assert!(!placement_visible(Rect::new(100.0, -500.0, 1200.0, 400.0), &screens), "title bar above every screen");
        assert!(!placement_visible(Rect::new(1880.0, 1030.0, 800.0, 600.0), &[screens[0]]), "only a corner showing");
        assert!(!placement_visible(Rect::new(0.0, 0.0, 800.0, 600.0), &[]));
    }

    #[test]
    fn sane_rects() {
        assert!(Rect::new(0.0, 34.0, 500.0, 600.0).is_sane());
        assert!(!Rect::new(f64::NAN, 0.0, 1.0, 1.0).is_sane());
        assert!(!Rect::new(0.0, 0.0, -1.0, 1.0).is_sane());
        assert!(!Rect::new(0.0, 0.0, 1e9, 1.0).is_sane());
    }
}
