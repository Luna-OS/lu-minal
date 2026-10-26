// A session window's content: the terminal (MoonContainerView) on the left and, when it is open,
// the cloud pane on the right with a divider between them that can be dragged. The window's title
// bar is transparent over a full-size content view, so the pane starts below it (the traffic
// lights sit over the terminal, the title bar's own button for the pane on the right). Changing
// the pane's width changes the terminal's, and SwiftTerm passes the new size on to lu-minal.
import AppKit

final class SessionContentView: NSView {
    let terminalArea: MoonContainerView
    let pane: CloudPaneView
    private let divider: PaneDividerView

    /// The divider's width: a 1 pt line in the middle of an area wide enough to grab.
    static let dividerWidth: CGFloat = 7
    static let minimumPaneWidth: CGFloat = 320
    static let minimumTerminalWidth: CGFloat = 320

    /// Called when a drag of the divider ends, with the pane's new width.
    var onPaneResized: ((CGFloat) -> Void)?

    var isPaneVisible = false {
        didSet {
            guard isPaneVisible != oldValue else { return }
            pane.isHidden = !isPaneVisible
            divider.isHidden = !isPaneVisible
            layoutViews()
        }
    }

    /// The pane's width as the user left it (a narrow window may show it narrower).
    var paneWidth: CGFloat {
        didSet { layoutViews() }
    }

    init(frame: NSRect, terminalArea: MoonContainerView, pane: CloudPaneView, paneWidth: CGFloat) {
        self.terminalArea = terminalArea
        self.pane = pane
        self.paneWidth = paneWidth
        self.divider = PaneDividerView(frame: .zero)
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = MoonPalette.nsColor(MoonPalette.background).cgColor
        pane.isHidden = true
        divider.isHidden = true
        addSubview(terminalArea)
        addSubview(divider)
        addSubview(pane)
        divider.onDrag = { [weak self] x in self?.dragDivider(to: x) }
        divider.onDragEnded = { [weak self] in
            guard let self = self else { return }
            self.onPaneResized?(self.paneWidth)
        }
        layoutViews()
    }

    required init?(coder: NSCoder) {
        fatalError("SessionContentView is created in code")
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
        layoutViews()
    }

    override func layout() {
        super.layout()
        layoutViews()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        layoutViews()
    }

    /// The pane's width in a window this wide: `paneWidth`, but never so wide that the terminal
    /// gets less than its minimum (in a window too narrow for both minimums they share it).
    func shownPaneWidth() -> CGFloat {
        return fitted(paneWidth)
    }

    private func fitted(_ width: CGFloat) -> CGFloat {
        let available = max(0, bounds.width - SessionContentView.dividerWidth)
        let widest = max(available - SessionContentView.minimumTerminalWidth, available / 2)
        return max(0, min(max(width, SessionContentView.minimumPaneWidth), widest))
    }

    func layoutViews() {
        guard isPaneVisible else {
            if terminalArea.frame != bounds {
                terminalArea.frame = bounds
            }
            return
        }
        // With a full-size content view this view covers the whole window; `contentLayoutRect`
        // (window coordinates) is the part the title bar leaves.
        var titleBar: CGFloat = 0
        if let window = window {
            titleBar = max(0, bounds.height - window.contentLayoutRect.maxY)
        }
        let width = shownPaneWidth()
        let height = max(0, bounds.height - titleBar)
        let paneX = bounds.width - width
        let dividerX = max(0, paneX - SessionContentView.dividerWidth)
        let terminalFrame = NSRect(x: 0, y: 0, width: dividerX, height: bounds.height)
        if terminalArea.frame != terminalFrame {
            terminalArea.frame = terminalFrame
        }
        let dividerFrame = NSRect(x: dividerX, y: 0, width: SessionContentView.dividerWidth, height: height)
        if divider.frame != dividerFrame {
            divider.frame = dividerFrame
            window?.invalidateCursorRects(for: divider)
        }
        let paneFrame = NSRect(x: paneX, y: 0, width: width, height: height)
        if pane.frame != paneFrame {
            pane.frame = paneFrame
        }
    }

    /// The divider follows the mouse: `x` is where it is, in this view's coordinates.
    private func dragDivider(to x: CGFloat) {
        paneWidth = fitted(bounds.width - x - SessionContentView.dividerWidth / 2)
    }
}

/// The line between the terminal and the pane; drag it to resize them.
final class PaneDividerView: NSView {
    /// Called while dragging, with the mouse's x in the superview's coordinates.
    var onDrag: ((CGFloat) -> Void)?
    var onDragEnded: (() -> Void)?

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .resizeLeftRight)
    }

    override var mouseDownCanMoveWindow: Bool {
        return false
    }

    override func draw(_ dirtyRect: NSRect) {
        MoonPalette.nsColor(MoonPalette.background).setFill()
        bounds.fill()
        MoonPalette.nsColor(MoonPalette.hairline).setFill()
        NSRect(x: floor(bounds.midX), y: 0, width: 1, height: bounds.height).fill()
    }

    override func mouseDown(with event: NSEvent) {
        // Taking the mouse-down makes the drags that follow come here.
    }

    override func mouseDragged(with event: NSEvent) {
        guard let superview = superview else { return }
        onDrag?(superview.convert(event.locationInWindow, from: nil).x)
    }

    override func mouseUp(with event: NSEvent) {
        onDragEnded?()
    }
}
