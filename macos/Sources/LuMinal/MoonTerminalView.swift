// The terminal of one session: SwiftTerm's LocalProcessTerminalView, plus what happens after
// lu-minal has exited (the next key press closes the window instead of going to a dead process).
import AppKit
import SwiftTerm

final class MoonTerminalView: LocalProcessTerminalView {
    /// Set once lu-minal has exited; from then on a key press calls `onKeyAfterExit`.
    var processEnded = false
    /// Called for the first key press after lu-minal has exited.
    var onKeyAfterExit: (() -> Void)?

    override func send(source: TerminalView, data: ArraySlice<UInt8>) {
        guard processEnded else {
            super.send(source: source, data: data)
            return
        }
        // Focus (ESC [ I / ESC [ O) and mouse (ESC [ M ..., ESC [ < ...) reports are not key presses.
        let bytes = Array(data)
        if bytes.count >= 3, bytes[0] == 0x1b, bytes[1] == 0x5b, [0x49, 0x4f, 0x4d, 0x3c].contains(bytes[2]) {
            return
        }
        onKeyAfterExit?()
    }

    /// Hides SwiftTerm's scroll bar: lu-minal draws a full-screen UI in the alternate screen, where
    /// there is nothing to scroll (the mouse wheel still scrolls the normal screen).
    func hideScroller() {
        for case let scroller as NSScroller in subviews {
            scroller.isHidden = true
        }
    }
}

/// The window's content view: the night sky colour edge to edge (also under the transparent title
/// bar) with the terminal laid out below the title bar.
final class MoonContainerView: NSView {
    let terminal: NSView
    /// Space around the terminal so text doesn't touch the window edges.
    static let padding = NSEdgeInsets(top: 2, left: 10, bottom: 8, right: 4)

    init(frame: NSRect, terminal: NSView) {
        self.terminal = terminal
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = MoonPalette.nsColor(MoonPalette.background).cgColor
        addSubview(terminal)
        layoutTerminal()
    }

    required init?(coder: NSCoder) {
        fatalError("MoonContainerView is created in code")
    }

    override var isOpaque: Bool {
        return true
    }

    override func draw(_ dirtyRect: NSRect) {
        MoonPalette.nsColor(MoonPalette.background).setFill()
        dirtyRect.fill()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layoutTerminal()
    }

    override func layout() {
        super.layout()
        layoutTerminal()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        layoutTerminal()
    }

    /// Puts the terminal below the title bar. With a full-size content view this view covers the
    /// whole window, and `contentLayoutRect` (window coordinates) is the part the title bar leaves.
    func layoutTerminal() {
        var titleBar: CGFloat = 0
        if let window = window {
            titleBar = max(0, bounds.height - window.contentLayoutRect.maxY)
        }
        let p = MoonContainerView.padding
        let frame = NSRect(
            x: p.left,
            y: p.bottom,
            width: max(0, bounds.width - p.left - p.right),
            height: max(0, bounds.height - titleBar - p.top - p.bottom)
        )
        if terminal.frame != frame {
            terminal.frame = frame
        }
    }
}
