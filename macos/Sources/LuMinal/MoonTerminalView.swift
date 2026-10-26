// The terminal of one session: SwiftTerm's LocalProcessTerminalView, plus the cloud pane's escape
// sequence (taken out of lu-minal's output before SwiftTerm parses it) and what happens after
// lu-minal has exited (the next key press closes the window instead of going to a dead process).
import AppKit
import SwiftTerm

final class MoonTerminalView: LocalProcessTerminalView {
    /// Set once lu-minal has exited; from then on a key press calls `onKeyAfterExit`.
    var processEnded = false
    /// Called for the first key press after lu-minal has exited.
    var onKeyAfterExit: (() -> Void)?
    /// Called with every cloud pane command (OSC 7701) in lu-minal's output.
    var onPaneCommand: ((PaneCommand) -> Void)?

    private var paneSequences = PaneSequenceFilter()

    /// lu-minal's output, as SwiftTerm 1.10's LocalProcess reads it from the PTY (on the main
    /// queue). OSC 7701 sequences go to the window, the rest to SwiftTerm unchanged and in order;
    /// the filter keeps its state between reads, so a sequence may be split anywhere.
    override func dataReceived(slice: ArraySlice<UInt8>) {
        let filtered = paneSequences.filter(slice)
        if !filtered.bytes.isEmpty {
            super.dataReceived(slice: filtered.bytes)
        }
        for command in filtered.commands {
            onPaneCommand?(command)
        }
    }

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

    /// Cmd+V. Files copied in Finder go to lu-minal as their file URLs, the way a drop on the
    /// terminal pastes them, so lu-minal attaches them (the pasteboard's text is only their names).
    /// Anything else is SwiftTerm's paste: with a picture and no text on the pasteboard that is an
    /// empty paste, on which lu-minal reads the picture from the clipboard itself.
    override func paste(_ sender: Any) {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        if !processEnded,
           let urls = NSPasteboard.general.readObjects(forClasses: [NSURL.self], options: options) as? [URL],
           !urls.isEmpty {
            send(txt: "\u{1b}[200~" + urls.map { $0.absoluteString }.joined(separator: " ") + "\u{1b}[201~")
            return
        }
        super.paste(sender)
    }

    /// Hides SwiftTerm's scroll bar: lu-minal draws a full-screen UI in the alternate screen, where
    /// there is nothing to scroll (the mouse wheel still scrolls the normal screen).
    func hideScroller() {
        for case let scroller as NSScroller in subviews {
            scroller.isHidden = true
        }
    }
}

/// The terminal's side of the window (all of it while the cloud pane is closed): the night sky
/// colour edge to edge (also under the transparent title bar) with the terminal laid out below
/// the title bar. It is as tall as the window's content view (SessionContentView).
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
