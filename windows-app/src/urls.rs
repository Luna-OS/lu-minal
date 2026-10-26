//! Where the two web views may go. The cloud pane shows claude.ai: pages there (and on
//! anthropic.com, and Cloudflare's check) load in place, Google's sign-in pages are refused with
//! a note (Google blocks sign-in inside embedded web views), and every other link opens in the
//! default browser. The terminal's own page never leaves the app's origin.
//!
//! Hosts are compared on the parsed URL (WHATWG rules, as the browser sees it), never on the
//! string, so `https://claude.ai@evil.example/` or `https://claude.ai.evil.example/` are not
//! mistaken for claude.ai.

use url::Url;

/// The cloud pane's start page.
pub const PANE_HOME: &str = "https://claude.ai/code";

/// The custom protocol the terminal page is served from (`https://lu-minal.localhost/...` in
/// WebView2, which maps custom protocols to that form).
pub const APP_PROTOCOL: &str = "lu-minal";
/// The terminal page's origin as WebView2 loads it.
pub const APP_ORIGIN: &str = "https://lu-minal.localhost";

/// Shown in the pane when a link leads to Google's sign-in.
pub const GOOGLE_SIGN_IN_NOTICE: &str = "Google sign-in doesn't work inside lu-minal. Use 'Continue with email' (Claude sends you a code).";

/// What to do with a navigation in the cloud pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Navigation {
    /// Load it in the pane.
    Allow,
    /// Refuse it and show [`GOOGLE_SIGN_IN_NOTICE`].
    GoogleSignIn,
    /// Refuse it and open this URL in the default browser.
    External(String),
    /// Refuse it silently (schemes like file: or javascript:, unparsable URLs).
    Refuse,
}

/// `host` is `domain` or a subdomain of it.
fn on_domain(host: &str, domain: &str) -> bool {
    host == domain || (host.len() > domain.len() && host.ends_with(domain) && host.as_bytes()[host.len() - domain.len() - 1] == b'.')
}

/// claude.ai and its subdomains.
fn is_claude_host(host: &str) -> bool {
    on_domain(host, "claude.ai")
}

/// The hosts the pane shows in place: claude.ai, anthropic.com (help pages, the console) and
/// Cloudflare's bot check, which claude.ai sits behind.
fn is_pane_host(host: &str) -> bool {
    is_claude_host(host) || on_domain(host, "anthropic.com") || host == "challenges.cloudflare.com"
}

/// Google's sign-in pages (Google refuses them in embedded web views: "This browser or app may
/// not be secure").
pub fn is_google_sign_in_host(host: &str) -> bool {
    host == "accounts.google.com"
        || host.starts_with("accounts.google.")
        || host == "accounts.youtube.com"
        || host == "myaccount.google.com"
}

fn parse(raw: &str) -> Option<Url> {
    Url::parse(raw.trim()).ok()
}

/// An https URL on the default port without user name or password.
fn plain_https(url: &Url) -> Option<&str> {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return None;
    }
    url.host_str()
}

/// The URL an `open` command (or a terminal link) may show in the pane: https on claude.ai or a
/// subdomain. Returns it normalised, or `None` when it is refused.
pub fn pane_url(raw: &str) -> Option<String> {
    let url = parse(raw)?;
    is_claude_host(plain_https(&url)?).then(|| url.to_string())
}

/// What to do with a top-level navigation (or a new-window request) in the cloud pane.
pub fn classify_pane_navigation(raw: &str) -> Navigation {
    let Some(url) = parse(raw) else { return Navigation::Refuse };
    match url.scheme() {
        "about" if url.path() == "blank" => Navigation::Allow,
        // A blob made by a page in the pane (a download, a preview) belongs to its origin.
        "blob" => match url.origin() {
            url::Origin::Tuple(scheme, url::Host::Domain(host), port) if scheme == "https" && port == 443 && is_pane_host(&host) => {
                Navigation::Allow
            }
            _ => Navigation::Refuse,
        },
        "https" | "http" => {
            let host = url.host_str().unwrap_or_default().to_string();
            if is_google_sign_in_host(&host) {
                Navigation::GoogleSignIn
            } else if plain_https(&url).is_some_and(is_pane_host) {
                Navigation::Allow
            } else {
                Navigation::External(url.to_string())
            }
        }
        "mailto" => Navigation::External(url.to_string()),
        _ => Navigation::Refuse,
    }
}

/// A URL the default browser may be asked to open (from the pane or a terminal link).
pub fn external_url(raw: &str) -> Option<String> {
    let url = parse(raw)?;
    matches!(url.scheme(), "https" | "http" | "mailto").then(|| url.to_string())
}

/// Where a link clicked in the terminal goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    Pane(String),
    Browser(String),
}

/// A link clicked in the terminal (OSC 8): claude.ai opens in the pane, other web links in the
/// default browser, anything else nowhere.
pub fn terminal_link(raw: &str) -> Option<LinkTarget> {
    if let Some(url) = pane_url(raw) {
        return Some(LinkTarget::Pane(url));
    }
    external_url(raw).map(LinkTarget::Browser)
}

/// Whether the terminal's web view may load this URL: only the app's own pages.
pub fn is_app_page(raw: &str) -> bool {
    parse(raw).is_some_and(|url| url.origin().ascii_serialization() == APP_ORIGIN && url.username().is_empty() && url.password().is_none())
}

/// The URL shown in the pane's header: host and path, without the scheme and query.
pub fn display_url(raw: &str) -> String {
    match parse(raw) {
        Some(url) if url.host_str().is_some() => {
            let path = url.path();
            format!("{}{}", url.host_str().unwrap_or_default(), if path == "/" { "" } else { path })
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_accepts_only_https_claude_ai() {
        assert_eq!(pane_url("https://claude.ai/code").as_deref(), Some("https://claude.ai/code"));
        assert_eq!(pane_url("https://claude.ai").as_deref(), Some("https://claude.ai/"));
        assert_eq!(pane_url("https://CLAUDE.ai/code/session_01?x=1#y").as_deref(), Some("https://claude.ai/code/session_01?x=1#y"));
        assert!(pane_url("https://www.claude.ai/code").is_some());
        assert!(pane_url("https://claude.ai:443/code").is_some(), "the default port is dropped by the parser");
        for refused in [
            "http://claude.ai/code",
            "https://claude.ai.evil.example/",
            "https://evilclaude.ai/",
            "https://claude.ai@evil.example/",
            "https://user:pw@claude.ai/",
            "https://claude.ai:8443/",
            "https://anthropic.com/",
            "javascript:alert(1)",
            "file:///C:/Windows/notepad.exe",
            "claude.ai/code",
            "",
            "https://claude.ai./",
            "https://[::1]/",
        ] {
            assert_eq!(pane_url(refused), None, "{refused}");
        }
    }

    #[test]
    fn the_pane_loads_claude_anthropic_and_the_cloudflare_check_in_place() {
        for url in [
            "https://claude.ai/code",
            "https://claude.ai/login?returnTo=%2Fcode",
            "https://support.claude.ai/x",
            "https://www.anthropic.com/legal",
            "https://anthropic.com/",
            "https://console.anthropic.com/",
            "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile",
            "about:blank",
            "blob:https://claude.ai/0b6f1e2c-9a8f-4b1e-8d3c-2f5a6b7c8d9e",
        ] {
            assert_eq!(classify_pane_navigation(url), Navigation::Allow, "{url}");
        }
    }

    #[test]
    fn google_sign_in_is_refused_with_the_notice() {
        for url in [
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
            "https://accounts.google.de/signin",
            "https://accounts.youtube.com/accounts/SetSID",
            "http://accounts.google.com/",
            "https://myaccount.google.com/",
        ] {
            assert_eq!(classify_pane_navigation(url), Navigation::GoogleSignIn, "{url}");
        }
        assert!(GOOGLE_SIGN_IN_NOTICE.contains("Continue with email"));
    }

    #[test]
    fn other_links_go_to_the_default_browser() {
        assert_eq!(
            classify_pane_navigation("https://github.com/Luna-OS/lu-minal"),
            Navigation::External("https://github.com/Luna-OS/lu-minal".into())
        );
        assert_eq!(classify_pane_navigation("http://claude.ai/"), Navigation::External("http://claude.ai/".into()));
        assert_eq!(
            classify_pane_navigation("https://claude.ai.evil.example/"),
            Navigation::External("https://claude.ai.evil.example/".into())
        );
        assert_eq!(
            classify_pane_navigation("https://www.google.com/search?q=moon"),
            Navigation::External("https://www.google.com/search?q=moon".into())
        );
        assert_eq!(classify_pane_navigation("mailto:support@anthropic.com"), Navigation::External("mailto:support@anthropic.com".into()));
    }

    #[test]
    fn everything_else_is_refused() {
        for url in [
            "file:///C:/Users/ada/secret.txt",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "ms-settings:privacy",
            "lu-minal://localhost/index.html",
            "blob:https://evil.example/123",
            "about:config",
            "not a url",
        ] {
            assert_eq!(classify_pane_navigation(url), Navigation::Refuse, "{url}");
        }
    }

    #[test]
    fn terminal_links() {
        assert_eq!(terminal_link("https://claude.ai/code/session_1"), Some(LinkTarget::Pane("https://claude.ai/code/session_1".into())));
        assert_eq!(terminal_link("https://github.com/"), Some(LinkTarget::Browser("https://github.com/".into())));
        assert_eq!(terminal_link("http://localhost:5173/"), Some(LinkTarget::Browser("http://localhost:5173/".into())));
        assert_eq!(terminal_link("file:///etc/passwd"), None);
        assert_eq!(terminal_link("javascript:alert(1)"), None);
        assert_eq!(external_url("vscode://file/x"), None);
    }

    #[test]
    fn the_terminal_page_stays_on_its_origin() {
        assert!(is_app_page("https://lu-minal.localhost/index.html"));
        assert!(is_app_page(&format!("{APP_ORIGIN}/")));
        assert!(!is_app_page("http://lu-minal.localhost/index.html"));
        assert!(!is_app_page("https://lu-minal.localhost.evil.example/"));
        assert!(!is_app_page("https://claude.ai/code"));
        assert!(!is_app_page("about:blank"));
    }

    #[test]
    fn display_urls() {
        assert_eq!(display_url("https://claude.ai/code/session_1?tab=x"), "claude.ai/code/session_1");
        assert_eq!(display_url("https://claude.ai/"), "claude.ai");
        assert_eq!(display_url("about:blank"), "");
    }
}
