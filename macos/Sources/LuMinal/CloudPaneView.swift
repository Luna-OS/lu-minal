// The cloud pane beside the terminal: the real claude.ai website (https://claude.ai/code, the
// Claude Code cloud sessions) in a WKWebView, under a slim Moon header with back, reload, open in
// browser and close. The app only shows the page: it injects no scripts, reads nothing from it and
// keeps WebKit's own user agent. It decides where the page may go (CloudPanePolicy), opens other
// links in the default browser, and answers what a browser would: a file picker for uploads,
// alert / confirm / prompt, downloads to ~/Downloads. Camera and microphone requests are refused,
// and so are windows a script opens without a click (a popup blocker, as in Safari).
// The sign-in lives in WebKit's persistent data store for the app, so it survives restarts and is
// shared by all windows; View > Sign Out of the Cloud Pane removes it.
import AppKit
import WebKit

/// The pane's remembered state: open or closed (closed until it is first opened) and its width.
enum CloudPaneSettings {
    private static let openKey = "CloudPaneOpen"
    private static let widthKey = "CloudPaneWidth"
    static let defaultWidth: CGFloat = 480

    static var isOpen: Bool {
        get { return UserDefaults.standard.bool(forKey: openKey) }
        set { UserDefaults.standard.set(newValue, forKey: openKey) }
    }

    static var width: CGFloat {
        get {
            let value = UserDefaults.standard.double(forKey: widthKey)
            return value >= 200 && value <= 5000 ? CGFloat(value) : defaultWidth
        }
        set { UserDefaults.standard.set(Double(newValue), forKey: widthKey) }
    }
}

final class CloudPaneView: NSView, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    static let headerHeight: CGFloat = 30

    /// Called when the header's close button is clicked.
    var onClose: (() -> Void)?

    private let header: CloudPaneHeaderView
    private let banner: CloudPaneBannerView
    private let placeholder: NSTextField
    /// Made when the pane is first shown, so a window that never shows it starts no web process.
    private var webView: WKWebView?
    private var observations: [NSKeyValueObservation] = []
    /// The page the pane was last asked to load (what reload loads when nothing has loaded yet).
    private var requestedURL: URL?
    /// The web view stays transparent until its first page arrives, so the pane doesn't flash white.
    private var revealed = false
    /// Downloads in progress (WebKit's download objects are kept alive here) and where they go.
    private var downloads: [ObjectIdentifier: (download: WKDownload, destination: URL?)] = [:]

    override init(frame frameRect: NSRect) {
        header = CloudPaneHeaderView(frame: .zero)
        banner = CloudPaneBannerView(frame: .zero)
        placeholder = NSTextField(wrappingLabelWithString: "")
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = MoonPalette.nsColor(MoonPalette.background).cgColor

        placeholder.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        placeholder.textColor = MoonPalette.nsColor(MoonPalette.muted)
        placeholder.alignment = .center
        placeholder.stringValue = "Loading claude.ai\u{2026}"
        addSubview(placeholder)

        banner.isHidden = true
        banner.onClose = { [weak self] in self?.hideBanner() }
        addSubview(banner)

        header.onBack = { [weak self] in self?.webView?.goBack() }
        header.onReload = { [weak self] in self?.reload() }
        header.onOpenInBrowser = { [weak self] in self?.openInBrowser() }
        header.onClose = { [weak self] in self?.onClose?() }
        addSubview(header)
        updateHeader()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(websiteDataWasRemoved(_:)),
            name: CloudPaneView.websiteDataRemoved,
            object: nil
        )
    }

    required init?(coder: NSCoder) {
        fatalError("CloudPaneView is created in code")
    }

    override var isFlipped: Bool {
        return true
    }

    override var isOpaque: Bool {
        return true
    }

    // MARK: What the window asks of the pane

    /// Whether the keyboard focus is in the pane (the page, or a field of the header).
    var containsFirstResponder: Bool {
        guard let responder = window?.firstResponder as? NSView else { return false }
        return responder.isDescendant(of: self)
    }

    /// Loads `url`; with nil, the home page unless the pane has a page already.
    func show(_ url: URL?) {
        let web = webView ?? makeWebView()
        if let url = url {
            load(url, in: web)
        } else if web.url == nil && !web.isLoading {
            load(requestedURL ?? CloudPanePolicy.homeURL, in: web)
        }
    }

    /// Stops the page before the window goes away.
    func tearDown() {
        NotificationCenter.default.removeObserver(self)
        observations.forEach { $0.invalidate() }
        observations = []
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
    }

    /// Posted once the pane's website data is gone; every pane then reloads its home page.
    static let websiteDataRemoved = Notification.Name("LuMinalCloudPaneWebsiteDataRemoved")

    /// Signs every window's pane out: removes the cookies and website data (the claude.ai sign-in
    /// included). The data store is the app's own and only the pane uses it, so all of it goes.
    static func removeWebsiteData() {
        let store = WKWebsiteDataStore.default()
        store.removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: Date(timeIntervalSince1970: 0),
            completionHandler: {
                NotificationCenter.default.post(name: CloudPaneView.websiteDataRemoved, object: nil)
            }
        )
    }

    /// After a sign-out: back to the home page, which now asks to sign in.
    @objc private func websiteDataWasRemoved(_ notification: Notification) {
        guard let web = webView else { return }
        load(CloudPanePolicy.homeURL, in: web)
    }

    // MARK: The page

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The app's persistent store: the sign-in survives restarts.
        configuration.websiteDataStore = WKWebsiteDataStore.default()
        // A popup blocker, as in Safari: window.open only after a click or a key press. WebKit on
        // macOS lets scripts open windows on their own by default, and every new window lands in
        // createWebViewWith, which loads it in the pane or hands it to the default browser, so a
        // script in any frame of the page could otherwise open browser tabs (or mail) unasked.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        // Dark, so the page's prefers-color-scheme picks its dark look, like the rest of the window.
        web.appearance = NSAppearance(named: .darkAqua)
        web.underPageBackgroundColor = MoonPalette.nsColor(MoonPalette.background)
        web.alphaValue = 0
        // canGoBack and url also change without a navigation callback (the page's own history).
        observations = [
            web.observe(\.canGoBack, options: []) { [weak self] _, _ in
                DispatchQueue.main.async { self?.updateHeader() }
            },
            web.observe(\.url, options: []) { [weak self] _, _ in
                DispatchQueue.main.async { self?.updateHeader() }
            },
        ]
        addSubview(web, positioned: .below, relativeTo: banner)
        webView = web
        layoutContents()
        return web
    }

    private func load(_ url: URL, in web: WKWebView) {
        requestedURL = url
        // A URLRequest: newer SDKs also have load(_: URL), which older ones lack.
        web.load(URLRequest(url: url))
        if !revealed {
            placeholder.stringValue = "Loading claude.ai\u{2026}"
            layoutContents()
        }
        updateHeader()
    }

    private func reload() {
        guard let web = webView else {
            show(nil)
            return
        }
        if web.url != nil {
            web.reload()
        } else {
            load(requestedURL ?? CloudPanePolicy.homeURL, in: web)
        }
    }

    /// Opens the page the pane shows in the default browser.
    private func openInBrowser() {
        var target = requestedURL ?? CloudPanePolicy.homeURL
        if let current = webView?.url, ["http", "https"].contains(current.scheme?.lowercased() ?? "") {
            target = current
        }
        NSWorkspace.shared.open(target)
    }

    private func updateHeader() {
        header.update(canGoBack: webView?.canGoBack ?? false, url: webView?.url ?? requestedURL)
    }

    private func reveal() {
        guard !revealed, let web = webView else { return }
        revealed = true
        web.alphaValue = 1
        placeholder.isHidden = true
    }

    private func showBanner(_ message: String, tone: CloudPaneBannerView.Tone) {
        banner.show(message, tone: tone)
        banner.isHidden = false
        layoutContents()
    }

    private func hideBanner() {
        guard !banner.isHidden else { return }
        banner.isHidden = true
        layoutContents()
    }

    /// Carries out a decision that keeps the page where it is.
    private func follow(_ decision: CloudPanePolicy.Navigation, to url: URL) {
        switch decision {
        case .allow, .ignore:
            break
        case .googleSignIn:
            showBanner(CloudPanePolicy.googleSignInMessage, tone: .notice)
        case .openInBrowser:
            NSWorkspace.shared.open(url)
        }
    }

    private func loadFailed(_ error: Error) {
        let failure = error as NSError
        // A navigation replaced by the next one, or one the pane stopped itself (policy, download).
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        if failure.domain == "WebKitErrorDomain" && failure.code == 102 { return }
        let message = "The page did not load: \(failure.localizedDescription)"
        if revealed {
            showBanner(message, tone: .notice)
        } else {
            placeholder.stringValue = message + "\nCheck your connection, then click reload."
            layoutContents()
        }
        updateHeader()
    }

    // MARK: Layout

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layoutContents()
    }

    override func layout() {
        super.layout()
        layoutContents()
    }

    private func layoutContents() {
        let width = bounds.width
        header.frame = NSRect(x: 0, y: 0, width: width, height: CloudPaneView.headerHeight)
        var top = CloudPaneView.headerHeight
        if !banner.isHidden {
            let height = banner.height(forWidth: width)
            banner.frame = NSRect(x: 0, y: top, width: width, height: height)
            top += height
        }
        let page = NSRect(x: 0, y: top, width: width, height: max(0, bounds.height - top))
        if let web = webView, web.frame != page {
            web.frame = page
        }
        let textWidth = max(0, width - 48)
        let text = placeholder.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: textWidth, height: 10_000)) ?? .zero
        placeholder.frame = NSRect(
            x: 24,
            y: top + max(24, floor((page.height - text.height) / 2) - 20),
            width: textWidth,
            height: ceil(text.height)
        )
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // Frames inside the page (the Cloudflare check, embedded widgets) load where the page puts
        // them. The policy is about the page itself and about new windows (no target frame).
        if let frame = navigationAction.targetFrame, !frame.isMainFrame {
            decisionHandler(.allow)
            return
        }
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        var decision = CloudPanePolicy.navigation(for: url)
        // Command-click asks for another window: for a web page, that is the browser.
        if decision == .allow, navigationAction.navigationType == .linkActivated,
           navigationAction.modifierFlags.contains(.command),
           ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            decision = .openInBrowser
        }
        decisionHandler(decision == .allow ? .allow : .cancel)
        follow(decision, to: url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame {
            let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
            if !navigationResponse.canShowMIMEType || disposition?.lowercased().hasPrefix("attachment") == true {
                decisionHandler(.download)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        reveal()
        hideBanner()
        updateHeader()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        reveal()
        updateHeader()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loadFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loadFailed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page's process went away (memory pressure, a crash): load the page again.
        if webView.url != nil {
            webView.reload()
        } else {
            load(requestedURL ?? CloudPanePolicy.homeURL, in: webView)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        track(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        track(download)
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // No second window (target=_blank, window.open): a page for the pane loads in the pane,
        // anything else goes to the browser.
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased(), scheme != "about" else {
            return nil
        }
        let decision = CloudPanePolicy.navigation(for: url)
        if decision == .allow {
            webView.load(navigationAction.request)
        } else {
            follow(decision, to: url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        // <input type="file">: the files the user picks, nothing else.
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.prompt = "Choose"
        guard let window = window else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
            return
        }
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = pageAlert(message, from: frame)
        alert.addButton(withTitle: "OK")
        presentAlert(alert) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = pageAlert(message, from: frame)
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        presentAlert(alert) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = pageAlert(prompt, from: frame)
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        presentAlert(alert) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        // The app asks for no camera or microphone access (it has no purpose strings for them).
        decisionHandler(.deny)
    }

    private func pageAlert(_ message: String, from frame: WKFrameInfo) -> NSAlert {
        let alert = NSAlert()
        let host = frame.securityOrigin.host
        alert.messageText = host.isEmpty ? "This page says" : "\(host) says"
        alert.informativeText = message
        return alert
    }

    /// Shows `alert` as a sheet on the window (or on its own if the pane is in none).
    private func presentAlert(_ alert: NSAlert, then handler: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window = window {
            alert.beginSheetModal(for: window, completionHandler: handler)
        } else {
            handler(alert.runModal())
        }
    }

    // MARK: WKDownloadDelegate

    private func track(_ download: WKDownload) {
        download.delegate = self
        downloads[ObjectIdentifier(download)] = (download: download, destination: nil)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            completionHandler(nil)
            return
        }
        let destination = CloudPanePolicy.downloadDestination(in: folder, suggested: suggestedFilename) { candidate in
            FileManager.default.fileExists(atPath: candidate.path)
        }
        downloads[ObjectIdentifier(download)] = (download: download, destination: destination)
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        let name = downloads.removeValue(forKey: ObjectIdentifier(download))?.destination?.lastPathComponent ?? "the file"
        showBanner("Saved \(name) to Downloads.", tone: .success)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let name = downloads.removeValue(forKey: ObjectIdentifier(download))?.destination?.lastPathComponent ?? "the file"
        showBanner("Could not download \(name): \(error.localizedDescription)", tone: .notice)
    }
}

/// The slim bar above the page: back and reload on the left, the page's address, then open in
/// browser and close on the right.
final class CloudPaneHeaderView: NSView {
    var onBack: (() -> Void)?
    var onReload: (() -> Void)?
    var onOpenInBrowser: (() -> Void)?
    var onClose: (() -> Void)?

    private let backButton: NSButton
    private let reloadButton: NSButton
    private let browserButton: NSButton
    private let closeButton: NSButton
    private let address: NSTextField

    override init(frame frameRect: NSRect) {
        backButton = CloudPaneHeaderView.iconButton(symbol: "chevron.left", label: "Back")
        reloadButton = CloudPaneHeaderView.iconButton(symbol: "arrow.clockwise", label: "Reload")
        browserButton = CloudPaneHeaderView.iconButton(symbol: "arrow.up.right.square", label: "Open in Browser")
        closeButton = CloudPaneHeaderView.iconButton(symbol: "xmark", label: "Close the Cloud Pane")
        address = NSTextField(labelWithString: "")
        super.init(frame: frameRect)
        address.font = NSFont.systemFont(ofSize: 11, weight: .regular)
        address.textColor = MoonPalette.nsColor(MoonPalette.muted)
        address.lineBreakMode = .byTruncatingMiddle
        address.maximumNumberOfLines = 1
        addSubview(address)
        let actions: [(NSButton, Selector)] = [
            (backButton, #selector(back(_:))),
            (reloadButton, #selector(reload(_:))),
            (browserButton, #selector(openInBrowser(_:))),
            (closeButton, #selector(closePane(_:))),
        ]
        for (button, action) in actions {
            button.target = self
            button.action = action
            addSubview(button)
        }
    }

    required init?(coder: NSCoder) {
        fatalError("CloudPaneHeaderView is created in code")
    }

    /// An SF Symbol at the pane's icon size.
    static func symbolImage(_ symbol: String, label: String?) -> NSImage? {
        let configuration = NSImage.SymbolConfiguration(pointSize: 12, weight: .medium)
        return NSImage(systemSymbolName: symbol, accessibilityDescription: label)?.withSymbolConfiguration(configuration)
    }

    /// A borderless button with an SF Symbol in lavender.
    static func iconButton(symbol: String, label: String) -> NSButton {
        let button = NSButton(image: symbolImage(symbol, label: label) ?? NSImage(), target: nil, action: nil)
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.contentTintColor = MoonPalette.nsColor(MoonPalette.lavender)
        button.toolTip = label
        button.setAccessibilityLabel(label)
        return button
    }

    /// "claude.ai/code/..." for the header: the host and path, without the scheme and query.
    static func addressText(_ url: URL?) -> String {
        guard let url = url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.host, !host.isEmpty else {
            return "claude.ai"
        }
        let path = components.path == "/" ? "" : components.path
        return host + path
    }

    func update(canGoBack: Bool, url: URL?) {
        backButton.isEnabled = canGoBack
        backButton.contentTintColor = MoonPalette.nsColor(canGoBack ? MoonPalette.lavender : MoonPalette.faint)
        address.stringValue = CloudPaneHeaderView.addressText(url)
        address.toolTip = url?.absoluteString
    }

    override var isFlipped: Bool {
        return true
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layoutButtons()
    }

    override func layout() {
        super.layout()
        layoutButtons()
    }

    private func layoutButtons() {
        let size = NSSize(width: 26, height: 24)
        let y = floor((bounds.height - 1 - size.height) / 2)
        backButton.frame = NSRect(origin: NSPoint(x: 6, y: y), size: size)
        reloadButton.frame = NSRect(origin: NSPoint(x: backButton.frame.maxX, y: y), size: size)
        closeButton.frame = NSRect(origin: NSPoint(x: bounds.width - 6 - size.width, y: y), size: size)
        browserButton.frame = NSRect(origin: NSPoint(x: closeButton.frame.minX - size.width, y: y), size: size)
        let left = reloadButton.frame.maxX + 6
        let right = browserButton.frame.minX - 6
        let height: CGFloat = 16
        address.frame = NSRect(x: left, y: floor((bounds.height - 1 - height) / 2), width: max(0, right - left), height: height)
    }

    override func draw(_ dirtyRect: NSRect) {
        MoonPalette.nsColor(MoonPalette.glass).setFill()
        bounds.fill()
        MoonPalette.nsColor(MoonPalette.hairline).setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }

    @objc private func back(_ sender: Any?) {
        onBack?()
    }

    @objc private func reload(_ sender: Any?) {
        onReload?()
    }

    @objc private func openInBrowser(_ sender: Any?) {
        onOpenInBrowser?()
    }

    @objc private func closePane(_ sender: Any?) {
        onClose?()
    }
}

/// A notice between the header and the page: Google sign-in, a page that did not load, a download.
final class CloudPaneBannerView: NSView {
    enum Tone {
        case notice
        case success
    }

    var onClose: (() -> Void)?

    private let icon: NSImageView
    private let label: NSTextField
    private let closeButton: NSButton

    override init(frame frameRect: NSRect) {
        icon = NSImageView(frame: .zero)
        label = NSTextField(wrappingLabelWithString: "")
        closeButton = CloudPaneHeaderView.iconButton(symbol: "xmark", label: "Dismiss")
        super.init(frame: frameRect)
        label.font = NSFont.systemFont(ofSize: 12, weight: .regular)
        label.textColor = MoonPalette.nsColor(MoonPalette.cream)
        label.isSelectable = true
        icon.imageScaling = .scaleProportionallyDown
        closeButton.target = self
        closeButton.action = #selector(dismiss(_:))
        addSubview(icon)
        addSubview(label)
        addSubview(closeButton)
    }

    required init?(coder: NSCoder) {
        fatalError("CloudPaneBannerView is created in code")
    }

    func show(_ message: String, tone: Tone) {
        label.stringValue = message
        let symbol = tone == .success ? "checkmark.circle" : "exclamationmark.circle"
        icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        icon.contentTintColor = MoonPalette.nsColor(tone == .success ? MoonPalette.mint : MoonPalette.warning)
        needsLayout = true
        needsDisplay = true
    }

    /// The banner's height at `width`: the message wraps.
    func height(forWidth width: CGFloat) -> CGFloat {
        let size = label.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: textWidth(width), height: 10_000))
        return max(34, ceil(size?.height ?? 16) + 18)
    }

    private func textWidth(_ width: CGFloat) -> CGFloat {
        return max(60, width - 36 - 34)
    }

    override var isFlipped: Bool {
        return true
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        layoutParts()
    }

    override func layout() {
        super.layout()
        layoutParts()
    }

    private func layoutParts() {
        icon.frame = NSRect(x: 12, y: 9, width: 16, height: 16)
        label.frame = NSRect(x: 36, y: 9, width: textWidth(bounds.width), height: max(0, bounds.height - 18))
        closeButton.frame = NSRect(x: bounds.width - 32, y: 5, width: 26, height: 24)
    }

    override func draw(_ dirtyRect: NSRect) {
        MoonPalette.nsColor(MoonPalette.raised).setFill()
        bounds.fill()
        MoonPalette.nsColor(MoonPalette.hairline).setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }

    @objc private func dismiss(_ sender: Any?) {
        onClose?()
    }
}
