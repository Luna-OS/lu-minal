// Where the cloud pane may go. It shows the real claude.ai website (the user's own logged-in view)
// and nothing else: lu-minal's `open` command may only load https pages on claude.ai, pages in the
// pane may move on to claude.ai, *.anthropic.com and the Cloudflare check, Google's sign-in pages
// are stopped with a message (Google refuses embedded web views), and every other link opens in
// the default browser. Foundation only, so macos/Tests/PaneTests can check it on any machine.
import Foundation

enum CloudPanePolicy {
    /// The pane's home page: the Claude Code cloud sessions.
    static let homeURL = URL(string: "https://claude.ai/code")!

    /// Shown when the page tries to go to Google's sign-in.
    static let googleSignInMessage =
        "Google sign-in doesn't work inside lu-minal. Use 'Continue with email' (Claude sends you a code)."

    /// What happens to a page the pane is asked to show (a link, a redirect, a new window).
    enum Navigation: Equatable {
        /// Load it in the pane.
        case allow
        /// Stay on the current page and show `googleSignInMessage`.
        case googleSignIn
        /// Open it in the default browser (or, for mailto:, the mail app) instead.
        case openInBrowser
        /// Do nothing.
        case ignore
    }

    // MARK: lu-minal's `open` command

    /// The URL an `open` command may load, or nil: https on claude.ai or one of its subdomains,
    /// written in plain URL characters (no spaces, backslashes or non-ASCII), with no user name or
    /// password and no port other than 443. This is the security boundary: any program in the
    /// terminal can send the command.
    static func paneURL(_ text: String) -> URL? {
        guard !text.isEmpty, text.utf8.count <= PaneSequenceFilter.maxSequenceLength,
              text.utf8.allSatisfy(isURLCharacter) else {
            return nil
        }
        guard let components = URLComponents(string: text),
              components.scheme?.lowercased() == "https",
              components.user == nil, components.password == nil,
              components.port == nil || components.port == 443,
              let host = dnsName(components.percentEncodedHost),
              isClaudeHost(host),
              let url = components.url else {
            return nil
        }
        return url
    }

    // MARK: Navigation in the pane

    /// What to do with `url` when the page (or the user, in the page) wants to go there.
    static func navigation(for url: URL) -> Navigation {
        let scheme = url.scheme?.lowercased() ?? ""
        switch scheme {
        case "about":
            // about:blank stays with the page.
            return .allow
        case "blob":
            // A blob: URL names the origin that made it ("blob:https://claude.ai/<uuid>"). Only
            // the pages the pane shows itself may put one in the pane: one made by a frame from
            // elsewhere (window.open from an embedded page) would show that page's content under
            // the pane's header, and no other browser could open it either.
            return blobOriginHost(url).map(isInPlaceHost) == true ? .allow : .ignore
        case "http", "https":
            break
        case "mailto":
            return .openInBrowser
        default:
            // file:, data:, javascript: and the schemes of other apps are not followed.
            return .ignore
        }
        let host = dnsName(URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedHost)
        if let host = host, isGoogleSignInHost(host) {
            return .googleSignIn
        }
        if scheme == "https", let host = host, isInPlaceHost(host) {
            return .allow
        }
        return .openInBrowser
    }

    /// The host of the https origin a blob: URL was made by, or nil (another scheme, an opaque
    /// "null" origin, a host that is not a plain DNS name).
    static func blobOriginHost(_ url: URL) -> String? {
        let text = url.absoluteString
        guard let colon = text.firstIndex(of: ":") else { return nil }
        guard let inner = URLComponents(string: String(text[text.index(after: colon)...])),
              inner.scheme?.lowercased() == "https",
              inner.user == nil, inner.password == nil,
              inner.port == nil || inner.port == 443 else {
            return nil
        }
        return dnsName(inner.percentEncodedHost)
    }

    /// claude.ai or a subdomain of it.
    static func isClaudeHost(_ host: String) -> Bool {
        return host == "claude.ai" || host.hasSuffix(".claude.ai")
    }

    /// The hosts whose pages load in the pane: claude.ai, *.claude.ai, *.anthropic.com and the
    /// Cloudflare check claude.ai sits behind.
    static func isInPlaceHost(_ host: String) -> Bool {
        return isClaudeHost(host) || host.hasSuffix(".anthropic.com") || host == "challenges.cloudflare.com"
    }

    /// Google's sign-in pages (accounts.google.com and its country variants, accounts.youtube.com).
    static func isGoogleSignInHost(_ host: String) -> Bool {
        return host == "accounts.google.com" || host.hasPrefix("accounts.google.") || host == "accounts.youtube.com"
    }

    /// `host` lowercased if it is a plain DNS name (letters, digits and "-" in non-empty labels),
    /// otherwise nil: no percent escapes, IP literals or trailing dots to compare around.
    static func dnsName(_ host: String?) -> String? {
        guard let host = host?.lowercased(), !host.isEmpty else { return nil }
        for label in host.split(separator: ".", omittingEmptySubsequences: false) {
            guard !label.isEmpty, label.utf8.allSatisfy({ isLetterOrDigit($0) || $0 == 0x2d }) else { return nil }
        }
        return host
    }

    // MARK: Downloads

    /// A file in `folder` for a download WebKit suggests `suggested` for: the name's last path
    /// component without leading dots, "download" when nothing is left, and " (2)", " (3)", ...
    /// before the extension while `exists` says the name is taken.
    static func downloadDestination(in folder: URL, suggested: String, exists: (URL) -> Bool) -> URL {
        var name = String(suggested.split(separator: "/").last ?? "")
        name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        while name.hasPrefix(".") {
            name.removeFirst()
        }
        if name.isEmpty {
            name = "download"
        }
        var base = name
        var suffix = ""
        if let dot = name.lastIndex(of: "."), dot != name.startIndex {
            base = String(name[..<dot])
            suffix = String(name[dot...])
        }
        var candidate = folder.appendingPathComponent(name)
        var number = 2
        while exists(candidate) {
            candidate = folder.appendingPathComponent("\(base) (\(number))\(suffix)")
            number += 1
        }
        return candidate
    }

    // MARK: Characters

    private static func isLetterOrDigit(_ byte: UInt8) -> Bool {
        return (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x30 && byte <= 0x39)
    }

    /// RFC 3986's unreserved and reserved characters and "%".
    private static func isURLCharacter(_ byte: UInt8) -> Bool {
        if isLetterOrDigit(byte) { return true }
        switch byte {
        case 0x2d, 0x2e, 0x5f, 0x7e: // - . _ ~
            return true
        case 0x3a, 0x2f, 0x3f, 0x23, 0x5b, 0x5d, 0x40: // : / ? # [ ] @
            return true
        case 0x21, 0x24, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x3b, 0x3d: // ! $ & ' ( ) * + , ; =
            return true
        case 0x25: // %
            return true
        default:
            return false
        }
    }
}
