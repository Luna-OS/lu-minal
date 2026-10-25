// One lu-minal session: a Moon-styled window (transparent title bar over a full-size night-sky
// content view) whose terminal runs lu-minal. When lu-minal exits, the window says so and the
// next key press closes it.
import AppKit
import SwiftTerm

final class SessionWindowController: NSWindowController, NSWindowDelegate, LocalProcessTerminalViewDelegate {
    let terminalView: MoonTerminalView
    let folder: URL?
    /// Called when the window has closed, so the app can forget the session.
    var onClose: ((SessionWindowController) -> Void)?

    private var started = false
    private var ended = false
    private var closed = false
    private var defaultTitle: String

    /// True while lu-minal is running in this window.
    var isRunning: Bool {
        return started && !ended
    }

    var fontSize: CGFloat {
        get { return terminalView.font.pointSize }
        set {
            terminalView.font = MoonFont.font(size: newValue)
            terminalView.hideScroller()
        }
    }

    var optionAsMeta: Bool {
        get { return terminalView.optionAsMetaKey }
        set { terminalView.optionAsMetaKey = newValue }
    }

    init(folder: URL?, fontSize: CGFloat, optionAsMeta: Bool) {
        self.folder = folder
        self.defaultTitle = folder?.lastPathComponent ?? "lu-minal"
        let frame = NSRect(x: 0, y: 0, width: 1100, height: 720)
        let terminal = MoonTerminalView(frame: frame)
        self.terminalView = terminal
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        super.init(window: window)
        configure(window: window, fontSize: fontSize, optionAsMeta: optionAsMeta)
    }

    required init?(coder: NSCoder) {
        fatalError("SessionWindowController is created in code")
    }

    private func configure(window: NSWindow, fontSize: CGFloat, optionAsMeta: Bool) {
        let night = MoonPalette.nsColor(MoonPalette.background)
        window.title = defaultTitle
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = night
        window.isOpaque = true
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 520, height: 320)
        window.delegate = self

        let t = terminalView
        t.appearance = NSAppearance(named: .darkAqua)
        t.processDelegate = self
        t.font = MoonFont.font(size: fontSize)
        t.nativeForegroundColor = MoonPalette.nsColor(MoonPalette.foreground)
        t.nativeBackgroundColor = night
        t.caretColor = MoonPalette.nsColor(MoonPalette.cursor)
        t.caretTextColor = MoonPalette.nsColor(MoonPalette.cursorText)
        t.selectedTextBackgroundColor = MoonPalette.nsColor(MoonPalette.selection)
        t.installColors(MoonPalette.terminalPalette())
        t.optionAsMetaKey = optionAsMeta
        t.hideScroller()
        t.onKeyAfterExit = { [weak self] in
            self?.window?.performClose(nil)
        }

        let container = MoonContainerView(frame: NSRect(origin: .zero, size: window.frame.size), terminal: t)
        window.contentView = container
        window.initialFirstResponder = t
        container.layoutTerminal()
    }

    /// Shows the window and focuses the terminal.
    func present() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        window?.makeFirstResponder(terminalView)
    }

    /// Starts lu-minal (once) with the login shell's environment.
    func start(environment: [String: String]) {
        guard !started, !ended else { return }
        started = true
        let command = Launcher.command(folder: folder, environment: environment)
        // One turn of the run loop first, so the terminal has its real size when the PTY opens.
        // (Not `isVisible`: a window minimized while the login shell was asked must still start.)
        DispatchQueue.main.async { [weak self] in
            guard let self = self, !self.closed else { return }
            self.terminalView.startProcess(
                executable: command.executable,
                args: command.args,
                environment: command.environment,
                execName: command.execName,
                currentDirectory: command.currentDirectory
            )
        }
    }

    /// Stops lu-minal (SIGTERM; lu-minal saves its session and stops its agents on it).
    func stopProcess() {
        if terminalView.process?.running == true {
            terminalView.terminate()
        }
    }

    private func sessionEnded(exitStatus: Int32?) {
        guard !ended else { return }
        ended = true
        terminalView.processEnded = true
        // Leave the alternate screen and turn off mouse / focus reporting and bracketed paste, in
        // case lu-minal could not restore the terminal itself.
        let reset = "\u{1b}[?1049l\u{1b}[?1000l\u{1b}[?1002l\u{1b}[?1003l\u{1b}[?1006l\u{1b}[?1004l\u{1b}[?2004l\u{1b}[0m\u{1b}[?25l"
        var status = ""
        if let code = exitStatus, code != 0 {
            // SwiftTerm 1.10 reports the raw wait status (exit code << 8), later versions the code.
            status = " (exit code \(code > 255 ? code >> 8 : code))"
        }
        let dim = "\u{1b}[38;2;93;87;137m"
        let accent = "\u{1b}[38;2;185;174;251m"
        let off = "\u{1b}[0m"
        terminalView.feed(text: reset + "\r\n\(dim)[lu-minal ended\(status)]\(off)  Press any key to close  \(dim)\u{00B7}\(off)  \(accent)Cmd+N\(off) for a new session\r\n")
        window?.title = "\(window?.title ?? defaultTitle) - ended"
    }

    // MARK: LocalProcessTerminalViewDelegate

    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {
        // The window decides the size; nothing to do.
    }

    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        window?.title = trimmed.isEmpty ? defaultTitle : trimmed
    }

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
        // lu-minal shows its project in the title already.
    }

    func processTerminated(source: TerminalView, exitCode: Int32?) {
        DispatchQueue.main.async { [weak self] in
            self?.sessionEnded(exitStatus: exitCode)
        }
    }

    // MARK: NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard isRunning else { return true }
        let alert = NSAlert()
        alert.messageText = "Close this lu-minal session?"
        alert.informativeText = "lu-minal is still running in this window. Closing it stops lu-minal and the agents it runs."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Close")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: sender) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self = self else { return }
            self.stopProcess()
            self.ended = true
            sender.close()
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        closed = true
        stopProcess()
        // Forget the session on the next turn of the run loop, not while AppKit is still closing
        // the window (the app holds the last reference to this controller).
        let callback = onClose
        DispatchQueue.main.async {
            callback?(self)
        }
    }
}
