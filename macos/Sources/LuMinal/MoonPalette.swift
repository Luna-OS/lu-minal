// The Moon terminal palette: the night-950 sky, cream text, a moonlight-gold cursor and the 16
// ANSI colours of Moon Code's terminal. It mirrors MOON_ANSI in src/platform/windows-terminal.ts
// value for value; test/platform/distribution.test.ts fails when the two drift apart.
import AppKit
import SwiftTerm

enum MoonPalette {
    /// night-950, the sky behind everything (window, title bar, terminal).
    static let background = "#0b0920"
    static let foreground = "#e9e4f7"
    /// Moonlight gold.
    static let cursor = "#e0c880"
    /// Text under a block cursor.
    static let cursorText = "#0b0920"
    /// lavender-400 at a third over night-950.
    static let selection = "#454069"

    /// The 16 ANSI colours: black, red, green, yellow, blue, magenta, cyan, white, then the bright ones.
    static let ansi: [String] = [
        "#1d1742", // black
        "#f28b92", // red
        "#7fe3c6", // green
        "#f3c766", // yellow
        "#9ad7f5", // blue
        "#b9aefb", // magenta
        "#8ee6e0", // cyan
        "#e9e4f7", // white
        "#5d5789", // bright black
        "#ffa3a9", // bright red
        "#a3f0da", // bright green
        "#f8d98f", // bright yellow
        "#bfe6fa", // bright blue
        "#d6cffd", // bright magenta
        "#b5f2ee", // bright cyan
        "#ffffff", // bright white
    ]

    /// An sRGB colour from "#rrggbb".
    static func nsColor(_ hex: String) -> NSColor {
        let (r, g, b) = components(hex)
        return NSColor(srgbRed: CGFloat(r) / 255.0, green: CGFloat(g) / 255.0, blue: CGFloat(b) / 255.0, alpha: 1.0)
    }

    /// A SwiftTerm colour (16 bits per channel) from "#rrggbb".
    static func terminalColor(_ hex: String) -> Color {
        let (r, g, b) = components(hex)
        return Color(red: UInt16(r) * 257, green: UInt16(g) * 257, blue: UInt16(b) * 257)
    }

    /// The ANSI palette in SwiftTerm's form, for `installColors`.
    static func terminalPalette() -> [Color] {
        return ansi.map { terminalColor($0) }
    }

    private static func components(_ hex: String) -> (Int, Int, Int) {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let value = Int(digits, radix: 16) ?? 0
        return ((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff)
    }
}

enum MoonFont {
    /// SF Mono at `size`: the installed "SF Mono" family when the user has it, otherwise the
    /// system monospaced font (which is SF Mono), and Menlo if that is somehow not fixed-pitch.
    static func font(size: CGFloat) -> NSFont {
        if let installed = NSFont(name: "SFMono-Regular", size: size) {
            return installed
        }
        let system = NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
        if system.isFixedPitch {
            return system
        }
        return NSFont(name: "Menlo-Regular", size: size) ?? system
    }
}
