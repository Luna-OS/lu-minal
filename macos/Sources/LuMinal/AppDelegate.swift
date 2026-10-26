// The app: the menu bar, one window per lu-minal session (Cmd+N, File > Open Folder..., folders
// dropped on the Dock icon or the app, `open -a LuMinal <folder>`), font size and the
// Option-as-Meta setting, the cloud pane's shortcut (Cmd+Shift+K) and sign-out, and the
// login-shell environment every session starts with.
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var sessions: [SessionWindowController] = []
    private var waiting: [SessionWindowController] = []
    private var environment: [String: String]?
    private var cascadePoint: NSPoint?
    private var optionAsMetaItem: NSMenuItem?
    private var cloudPaneShortcut: Any?

    static let defaultFontSize: CGFloat = 13
    private static let fontSizeKey = "FontSize"
    private static let optionAsMetaKey = "OptionAsMetaKey"
    private static let docsURL = "https://github.com/Luna-OS/lu-minal/blob/main/docs/install.md"
    private static let issuesURL = "https://github.com/Luna-OS/lu-minal/issues"

    // MARK: Settings

    /// The font size new windows get (and the last one chosen with Cmd+= / Cmd+-).
    private var fontSize: CGFloat {
        get {
            let value = UserDefaults.standard.double(forKey: AppDelegate.fontSizeKey)
            return value >= 8 && value <= 40 ? CGFloat(value) : AppDelegate.defaultFontSize
        }
        set {
            UserDefaults.standard.set(Double(newValue), forKey: AppDelegate.fontSizeKey)
        }
    }

    /// Option sends ESC + key (alt shortcuts) instead of typing characters. Off by default: on many
    /// keyboard layouts Option types @, [, ], { and }.
    private var optionAsMeta: Bool {
        get { return UserDefaults.standard.bool(forKey: AppDelegate.optionAsMetaKey) }
        set { UserDefaults.standard.set(newValue, forKey: AppDelegate.optionAsMetaKey) }
    }

    // MARK: Lifecycle

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        NSApp.mainMenu = buildMainMenu()
        installCloudPaneShortcut()
        ShellEnvironment.resolve { [weak self] env in
            self?.environmentResolved(env)
        }
    }

    /// Cmd+Shift+K shows and hides the key window's cloud pane. It is taken before the window
    /// dispatches the key, so neither lu-minal (the terminal would pass it on) nor the page (which
    /// could keep it for itself) ever gets it. The View menu shows the same shortcut.
    private func installCloudPaneShortcut() {
        cloudPaneShortcut = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard AppDelegate.isCloudPaneShortcut(event), let session = self?.keySession else {
                return event
            }
            if !event.isARepeat {
                session.toggleCloudPane()
            }
            return nil
        }
    }

    /// Command-Shift-K, with no other modifier (Caps Lock aside). The key is the one that types
    /// "k", or the K key's position on layouts that type no Latin letters there.
    static func isCloudPaneShortcut(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.capsLock)
        guard flags == [.command, .shift] else { return false }
        if let characters = event.charactersIgnoringModifiers, characters.unicodeScalars.allSatisfy({ $0.isASCII }) {
            return characters.lowercased() == "k"
        }
        return event.keyCode == 40 // kVK_ANSI_K
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        for folder in foldersFromArguments() {
            openSession(folder: folder)
        }
        // Folders opened from the Finder arrive through application(_:open:); open the home
        // session only when nothing else did.
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.sessions.isEmpty else { return }
            self.openSession(folder: nil)
        }
        activate()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.isFileURL {
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { continue }
            openSession(folder: isDir.boolValue ? url : url.deletingLastPathComponent())
        }
        activate()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag && sessions.isEmpty {
            openSession(folder: nil)
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let running = sessions.filter { $0.isRunning }.count
        guard running > 0 else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = running == 1 ? "Quit lu-minal?" : "Quit lu-minal and its \(running) sessions?"
        alert.informativeText = running == 1
            ? "lu-minal is still running in a window. Quitting stops it and the agents it runs."
            : "lu-minal is still running in \(running) windows. Quitting stops them and the agents they run."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }

    func applicationWillTerminate(_ notification: Notification) {
        for session in sessions {
            session.stopProcess()
        }
    }

    // MARK: Sessions

    @discardableResult
    func openSession(folder: URL?) -> SessionWindowController {
        let session = SessionWindowController(folder: folder, fontSize: fontSize, optionAsMeta: optionAsMeta)
        session.onClose = { [weak self] closed in
            guard let self = self else { return }
            self.sessions.removeAll { $0 === closed }
            self.waiting.removeAll { $0 === closed }
        }
        if let window = session.window {
            if let point = cascadePoint, !sessions.isEmpty {
                cascadePoint = window.cascadeTopLeft(from: point)
            } else {
                window.center()
                cascadePoint = window.cascadeTopLeft(from: NSPoint(x: window.frame.minX, y: window.frame.maxY))
            }
        }
        sessions.append(session)
        session.present()
        if let env = environment {
            session.start(environment: env)
        } else {
            waiting.append(session)
        }
        return session
    }

    private func environmentResolved(_ env: [String: String]?) {
        let resolved = env ?? ShellEnvironment.fallback()
        environment = resolved
        let ready = waiting
        waiting = []
        for session in ready {
            session.start(environment: resolved)
        }
    }

    /// Folders passed on the command line (`open -a LuMinal --args ~/code/app`, or the binary itself).
    private func foldersFromArguments() -> [URL] {
        var folders: [URL] = []
        for arg in CommandLine.arguments.dropFirst() where !arg.hasPrefix("-") {
            let path = (arg as NSString).expandingTildeInPath
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue {
                folders.append(URL(fileURLWithPath: path, isDirectory: true))
            }
        }
        return folders
    }

    private var keySession: SessionWindowController? {
        return NSApp.keyWindow?.windowController as? SessionWindowController
    }

    private func activate() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: Actions

    @objc func newSession(_ sender: Any?) {
        openSession(folder: nil)
    }

    @objc func openFolder(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Open"
        panel.message = "Choose a project folder for a new lu-minal session."
        panel.begin { [weak self] response in
            guard response == .OK, let self = self else { return }
            for url in panel.urls {
                self.openSession(folder: url)
            }
        }
    }

    @objc func biggerFont(_ sender: Any?) {
        setFontSize((keySession?.fontSize ?? fontSize) + 1)
    }

    @objc func smallerFont(_ sender: Any?) {
        setFontSize((keySession?.fontSize ?? fontSize) - 1)
    }

    @objc func actualSizeFont(_ sender: Any?) {
        setFontSize(AppDelegate.defaultFontSize)
    }

    private func setFontSize(_ size: CGFloat) {
        let clamped = min(max(size, 8), 40)
        keySession?.fontSize = clamped
        fontSize = clamped
    }

    @objc func toggleOptionAsMeta(_ sender: Any?) {
        let on = !optionAsMeta
        optionAsMeta = on
        for session in sessions {
            session.optionAsMeta = on
        }
        optionAsMetaItem?.state = on ? .on : .off
    }

    @objc func toggleCloudPane(_ sender: Any?) {
        keySession?.toggleCloudPane()
    }

    /// Removes the cloud pane's cookies and website data, so claude.ai asks to sign in again.
    @objc func signOutOfCloudPane(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Sign out of the cloud pane?"
        alert.informativeText = "This removes the cloud pane's cookies and website data from this Mac, so claude.ai asks you to sign in again. Your cloud sessions keep running."
        alert.addButton(withTitle: "Sign Out")
        alert.addButton(withTitle: "Cancel")
        let finish: (NSApplication.ModalResponse) -> Void = { response in
            if response == .alertFirstButtonReturn {
                CloudPaneView.removeWebsiteData()
            }
        }
        if let window = keySession?.window {
            alert.beginSheetModal(for: window, completionHandler: finish)
        } else {
            finish(alert.runModal())
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(toggleCloudPane(_:)) {
            menuItem.state = keySession?.isCloudPaneVisible == true ? .on : .off
            return keySession != nil
        }
        return true
    }

    @objc func openDocs(_ sender: Any?) {
        if let url = URL(string: AppDelegate.docsURL) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func openIssues(_ sender: Any?) {
        if let url = URL(string: AppDelegate.issuesURL) {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: Menus

    private func buildMainMenu() -> NSMenu {
        let main = NSMenu(title: "Main")

        let app = NSMenu(title: "lu-minal")
        app.addItem(withTitle: "About lu-minal", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(NSMenuItem.separator())
        let services = NSMenu(title: "Services")
        let servicesItem = app.addItem(withTitle: "Services", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        NSApp.servicesMenu = services
        app.addItem(NSMenuItem.separator())
        app.addItem(withTitle: "Hide lu-minal", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(NSMenuItem.separator())
        app.addItem(withTitle: "Quit lu-minal", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        attach(app, to: main)

        let file = NSMenu(title: "File")
        addItem(to: file, title: "New Window", action: #selector(newSession(_:)), key: "n")
        addItem(to: file, title: "Open Folder\u{2026}", action: #selector(openFolder(_:)), key: "o")
        file.addItem(NSMenuItem.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        attach(file, to: main)

        // Undo, Redo and Cut are for the cloud pane's text fields. While the terminal has the
        // focus they stay disabled (it has no Cut and turns Undo and Redo down, see
        // MoonTerminalView) and the keys go to the terminal as before.
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        attach(edit, to: main)

        let view = NSMenu(title: "View")
        addItem(to: view, title: "Bigger", action: #selector(biggerFont(_:)), key: "=")
        addItem(to: view, title: "Smaller", action: #selector(smallerFont(_:)), key: "-")
        addItem(to: view, title: "Actual Size", action: #selector(actualSizeFont(_:)), key: "0")
        view.addItem(NSMenuItem.separator())
        let meta = addItem(to: view, title: "Use Option as Meta Key", action: #selector(toggleOptionAsMeta(_:)), key: "")
        meta.state = optionAsMeta ? .on : .off
        optionAsMetaItem = meta
        view.addItem(NSMenuItem.separator())
        let cloudPane = addItem(to: view, title: "Cloud Pane", action: #selector(toggleCloudPane(_:)), key: "k")
        cloudPane.keyEquivalentModifierMask = [.command, .shift]
        addItem(to: view, title: "Sign Out of the Cloud Pane\u{2026}", action: #selector(signOutOfCloudPane(_:)), key: "")
        view.addItem(NSMenuItem.separator())
        let fullScreen = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        attach(view, to: main)

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(NSMenuItem.separator())
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        attach(window, to: main)
        NSApp.windowsMenu = window

        let help = NSMenu(title: "Help")
        addItem(to: help, title: "lu-minal Help", action: #selector(openDocs(_:)), key: "?")
        addItem(to: help, title: "Report an Issue", action: #selector(openIssues(_:)), key: "")
        attach(help, to: main)
        NSApp.helpMenu = help

        return main
    }

    /// Adds an item whose action goes to this delegate.
    @discardableResult
    private func addItem(to menu: NSMenu, title: String, action: Selector, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
        return item
    }

    private func attach(_ submenu: NSMenu, to main: NSMenu) {
        let item = NSMenuItem(title: submenu.title, action: nil, keyEquivalent: "")
        item.submenu = submenu
        main.addItem(item)
    }
}
