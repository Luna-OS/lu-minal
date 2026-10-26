// Checks the cloud pane's plain-Swift parts: the OSC 7701 filter (PaneSequenceFilter.swift) and
// the URL policy (CloudPanePolicy.swift). No XCTest, no AppKit: macos/scripts/test-pane.sh
// compiles these files with this one and runs the result, on macOS (CI) or Linux.
import Foundation

var failures = 0
var checks = 0

func check(_ condition: Bool, _ message: @autoclosure () -> String, line: Int = #line) {
    checks += 1
    if !condition {
        failures += 1
        print("FAIL (line \(line)): \(message())")
    }
}

func bytes(_ text: String) -> [UInt8] {
    return Array(text.utf8)
}

func show(_ data: [UInt8]) -> String {
    return data.map { b -> String in
        switch b {
        case 0x1b: return "<ESC>"
        case 0x07: return "<BEL>"
        case 0x20..<0x7f: return String(UnicodeScalar(b))
        default: return "<\(String(b, radix: 16))>"
        }
    }.joined()
}

/// Runs `chunks` through one filter, the way a terminal's reads would arrive.
func run(_ chunks: [ArraySlice<UInt8>]) -> (bytes: [UInt8], commands: [PaneCommand]) {
    var filter = PaneSequenceFilter()
    var out: [UInt8] = []
    var commands: [PaneCommand] = []
    for chunk in chunks {
        let result = filter.filter(chunk)
        out.append(contentsOf: result.bytes)
        commands.append(contentsOf: result.commands)
    }
    return (out, commands)
}

/// Checks `input` whole, split in two at every offset (for long inputs: every offset near the
/// start and the end, and every 97th), split in three at every pair of offsets (for short inputs)
/// and byte by byte: the output and the commands must always be the same.
func expect(_ name: String, _ input: [UInt8], output: [UInt8], commands: [PaneCommand], line: Int = #line) {
    func verify(_ chunks: [ArraySlice<UInt8>], _ how: String) {
        let result = run(chunks)
        check(result.bytes == output, "\(name) [\(how)]: output \(show(result.bytes)), expected \(show(output))", line: line)
        check(result.commands == commands, "\(name) [\(how)]: commands \(result.commands), expected \(commands)", line: line)
    }
    verify([input[...]], "whole")
    var cuts = Set(0...input.count)
    if input.count > 512 {
        cuts = Set(0...64).union(Set((input.count - 64)...input.count)).union(Set(stride(from: 0, to: input.count, by: 97)))
    }
    for cut in cuts.sorted() {
        verify([input[0..<cut], input[cut...]], "split at \(cut)")
    }
    if input.count <= 120 {
        for first in 0...input.count {
            for second in first...input.count {
                verify([input[0..<first], input[first..<second], input[second...]], "split at \(first) and \(second)")
            }
        }
    }
    verify(input.indices.map { input[$0...$0] }, "byte by byte")
}

let esc = "\u{1b}"
let bel = "\u{07}"
let st = "\u{1b}\\"

// MARK: - The filter

expect("plain text", bytes("hello, world\r\n"), output: bytes("hello, world\r\n"), commands: [])
expect("empty input", [], output: [], commands: [])

expect("open, BEL", bytes("a\(esc)]7701;open;https://claude.ai/code\(bel)b"),
       output: bytes("ab"), commands: [.open("https://claude.ai/code")])
expect("open, ST", bytes("a\(esc)]7701;open;https://claude.ai/code\(st)b"),
       output: bytes("ab"), commands: [.open("https://claude.ai/code")])
expect("show, hide, toggle", bytes("\(esc)]7701;show\(bel)\(esc)]7701;hide\(st)x\(esc)]7701;toggle\(bel)"),
       output: bytes("x"), commands: [.show, .hide, .toggle])
expect("an argument after show is ignored", bytes("\(esc)]7701;show;now\(bel)"), output: [], commands: [.show])
expect("only the first ; separates the URL", bytes("\(esc)]7701;open;https://claude.ai/a;b=c\(bel)"),
       output: [], commands: [.open("https://claude.ai/a;b=c")])

expect("unknown command", bytes("x\(esc)]7701;explode;now\(bel)y"), output: bytes("xy"), commands: [])
expect("upper case is a different command", bytes("\(esc)]7701;SHOW\(bel)"), output: [], commands: [])
expect("open without a URL", bytes("\(esc)]7701;open\(bel)\(esc)]7701;open;\(bel)"), output: [], commands: [])
expect("no command at all", bytes("\(esc)]7701\(bel)\(esc)]7701;\(bel)\(esc)]7701\(st)z"), output: bytes("z"), commands: [])

let title = "\(esc)]0;lu-minal \u{2014} app\(bel)"
let link = "\(esc)]8;;https://example.com\(st)a link\(esc)]8;;\(st)"
let directory = "\(esc)]7;file://host/Users/me\(bel)"
expect("OSC 0 title passes", bytes(title), output: bytes(title), commands: [])
expect("OSC 8 link passes", bytes(link), output: bytes(link), commands: [])
expect("OSC 7 (a prefix of 7701) passes", bytes(directory), output: bytes(directory), commands: [])
for other in ["77", "770", "7702", "77010", "17701", "7700"] {
    let sequence = "\(esc)]\(other);show\(bel)"
    expect("OSC \(other) passes", bytes(sequence), output: bytes(sequence), commands: [])
}
let csi = "\(esc)[31mred\(esc)[0m \(esc)[?1049h\(esc)[2J\(esc)M\(esc)7"
expect("CSI and ESC sequences pass", bytes(csi), output: bytes(csi), commands: [])
expect("ESC ESC ] 7701", bytes("\(esc)\(esc)]7701;show\(bel)"), output: bytes(esc), commands: [.show])
expect("ESC ] alone", bytes("\(esc)]\(esc)]7701;hide\(bel)"), output: bytes("\(esc)]"), commands: [.hide])

let moon = "\u{1F319} \u{4E2D}\u{6587} caf\u{E9}"
expect("interleaved output, other OSCs and UTF-8",
       bytes("\(moon)\(title)\(esc)]7701;open;https://claude.ai/code/session_1\(bel)\(link)\(moon)\(esc)[1m\(esc)]7701;hide\(st)\(moon)"),
       output: bytes("\(moon)\(title)\(link)\(moon)\(esc)[1m\(moon)"),
       commands: [.open("https://claude.ai/code/session_1"), .hide])

expect("a sequence broken off by another escape is not carried out",
       bytes("\(esc)]7701;open;https://claude.ai\(esc)[0mafter"), output: bytes("\(esc)[0mafter"), commands: [])
expect("broken off by the next sequence of ours",
       bytes("\(esc)]7701;hide\(esc)]7701;show\(bel)"), output: [], commands: [.show])
expect("CAN cancels", bytes("\(esc)]7701;show\u{18}after"), output: bytes("after"), commands: [])
expect("SUB cancels", bytes("\(esc)]7701;show\u{1a}after"), output: bytes("after"), commands: [])
expect("other C0 controls inside are ignored", bytes("\(esc)]7701;sh\r\now\(bel)"), output: [], commands: [.show])
expect("UTF-8 inside the payload is kept", bytes("\(esc)]7701;open;https://claude.ai/caf\u{E9}\(bel)"),
       output: [], commands: [.open("https://claude.ai/caf\u{E9}")])

// A lone ESC (or a partial introducer) at the end waits for the next chunk, then goes out.
do {
    var filter = PaneSequenceFilter()
    let first = filter.filter(bytes("abc\(esc)]77")[...])
    check(Array(first.bytes) == bytes("abc"), "the partial introducer is held back: \(show(Array(first.bytes)))")
    let second = filter.filter(bytes("0x")[...])
    check(Array(second.bytes) == bytes("\(esc)]770x"), "and given back when it is not ours: \(show(Array(second.bytes)))")
    let third = filter.filter(bytes("plain")[...])
    check(Array(third.bytes) == bytes("plain") && third.commands.isEmpty, "the filter is back to text")
}

// The fast path hands the chunk back untouched.
do {
    var filter = PaneSequenceFilter()
    let input = bytes("no escape here \u{1F319}")[...]
    let result = filter.filter(input)
    check(result.bytes == input && result.commands.isEmpty, "plain chunks pass as they are")
}

// The length limit: from ESC to the end of the terminator, at most 4096 bytes.
do {
    let prefix = "\(esc)]7701;open;https://claude.ai/"
    let fixed = prefix.utf8.count + 1 // + BEL
    let longest = String(repeating: "a", count: PaneSequenceFilter.maxSequenceLength - fixed)
    let accepted = bytes("\(prefix)\(longest)\(bel)")
    check(accepted.count == PaneSequenceFilter.maxSequenceLength, "the longest sequence is 4096 bytes")
    expect("a 4096-byte sequence is carried out", accepted, output: [], commands: [.open("https://claude.ai/\(longest)")])
    let tooLong = bytes("x\(prefix)\(longest)a\(bel)y")
    expect("a 4097-byte sequence is dropped", tooLong, output: bytes("xy"), commands: [])
    let longestST = String(longest.dropLast())
    expect("the limit counts both bytes of ST", bytes("\(prefix)\(longestST)\(st)"), output: [],
           commands: [.open("https://claude.ai/\(longestST)")])
    expect("and one more is too many", bytes("\(prefix)\(longest)\(st)"), output: [], commands: [])
    let huge = bytes("\(prefix)\(String(repeating: "b", count: 100_000))\(bel)\(esc)]7701;show\(bel)ok")
    let result = run([huge[...]])
    check(result.bytes == bytes("ok") && result.commands == [.show], "a huge sequence is dropped and the next one works")
}

// MARK: - The command parser

check(PaneSequenceFilter.command(from: bytes("open;https://claude.ai")) == .open("https://claude.ai"), "open")
check(PaneSequenceFilter.command(from: bytes("toggle")) == .toggle, "toggle")
check(PaneSequenceFilter.command(from: []) == nil, "empty")
check(PaneSequenceFilter.command(from: bytes(" show")) == nil, "no trimming")

// MARK: - URLs lu-minal may open

for good in [
    "https://claude.ai/code",
    "https://claude.ai",
    "https://claude.ai/",
    "https://claude.ai/code/session_011CUv?x=1#top",
    "https://www.claude.ai/new",
    "https://a.b.claude.ai/x",
    "HTTPS://Claude.AI/code",
    "https://claude.ai:443/code",
    "https://claude.ai/code/%E2%9C%93",
] {
    check(CloudPanePolicy.paneURL(good) != nil, "paneURL accepts \(good)")
}
for bad in [
    "",
    "http://claude.ai/code",
    "https://claude.ai.evil.com/",
    "https://evilclaude.ai/",
    "https://evil.com/claude.ai",
    "https://evil.com/?https://claude.ai",
    "https://claude.ai@evil.com/",
    "https://user:password@claude.ai/",
    "https://user@claude.ai/",
    "https://evil.com#@claude.ai",
    "https://evil.com\\@claude.ai/",
    "https://evil.com\\.claude.ai/",
    "https://claude.ai:8443/code",
    "https://claude.ai./code",
    "https://.claude.ai/",
    "https://x..claude.ai/",
    "https://evil.com%2F.claude.ai/",
    "https://[::1]/",
    "https://127.0.0.1/",
    " https://claude.ai/",
    "https://claude.ai/ code",
    "https://claude.ai/caf\u{E9}",
    "https://claude.a\u{131}/",
    "https:claude.ai/code",
    "https:/claude.ai/code",
    "//claude.ai/code",
    "claude.ai/code",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "https://claude.ai/\u{1b}]",
    "https://claude.ai/" + String(repeating: "a", count: 5000),
] {
    check(CloudPanePolicy.paneURL(bad) == nil, "paneURL refuses \(bad.debugDescription)")
}
check(CloudPanePolicy.paneURL("https://claude.ai/code")?.absoluteString == "https://claude.ai/code", "paneURL keeps the URL")
check(CloudPanePolicy.homeURL.absoluteString == "https://claude.ai/code", "the home page")

// MARK: - Navigation in the pane

func navigation(_ text: String) -> CloudPanePolicy.Navigation? {
    guard let url = URL(string: text) else { return nil }
    return CloudPanePolicy.navigation(for: url)
}

for (text, expected) in [
    ("https://claude.ai/code", CloudPanePolicy.Navigation.allow),
    ("https://claude.ai/login?returnTo=%2Fcode", .allow),
    ("https://www.claude.ai/", .allow),
    ("https://docs.anthropic.com/en/docs/claude-code", .allow),
    ("https://www.anthropic.com/legal/privacy", .allow),
    ("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile", .allow),
    ("about:blank", .allow),
    ("blob:https://claude.ai/0b5ef5c0-1c7a-4d61-9d51-5e8f43c3bd10", .allow),
    ("blob:https://a.claude.ai/0b5ef5c0-1c7a-4d61-9d51-5e8f43c3bd10", .allow),
    ("blob:https://docs.anthropic.com/0b5ef5c0-1c7a-4d61-9d51-5e8f43c3bd10", .allow),
    ("BLOB:https://claude.ai/0b5ef5c0-1c7a-4d61-9d51-5e8f43c3bd10", .allow),
    ("blob:https://www.claudeusercontent.com/0b5ef5c0-1c7a-4d61-9d51-5e8f43c3bd10", .ignore),
    ("blob:https://claude.ai.evil.com/0b5ef5c0", .ignore),
    ("blob:https://evil.com/claude.ai", .ignore),
    ("blob:https://claude.ai@evil.com/0b5ef5c0", .ignore),
    ("blob:https://claude.ai:8443/0b5ef5c0", .ignore),
    ("blob:http://claude.ai/0b5ef5c0", .ignore),
    ("blob:null/0b5ef5c0-1c7a-4d61-9d51-5e8f43c3bd10", .ignore),
    ("blob:0b5ef5c0-1c7a-4d61-9d51-5e8f43c3bd10", .ignore),
    ("https://accounts.google.com/o/oauth2/v2/auth?client_id=x", .googleSignIn),
    ("https://accounts.google.co.uk/ServiceLogin", .googleSignIn),
    ("http://accounts.google.com/", .googleSignIn),
    ("https://accounts.youtube.com/accounts/SetSID", .googleSignIn),
    ("https://github.com/Luna-OS/lu-minal/pull/1", .openInBrowser),
    ("https://anthropic.com/", .openInBrowser),
    ("https://cloudflare.com/", .openInBrowser),
    ("https://claude.ai.evil.com/", .openInBrowser),
    ("https://evilanthropic.com/", .openInBrowser),
    ("https://www.google.com/search?q=claude", .openInBrowser),
    ("http://claude.ai/code", .openInBrowser),
    ("http://example.com/", .openInBrowser),
    ("mailto:support@anthropic.com", .openInBrowser),
    ("file:///etc/passwd", .ignore),
    ("data:text/html,hi", .ignore),
    ("javascript:alert(1)", .ignore),
    ("vscode://file/tmp/x", .ignore),
] {
    let decision = navigation(text)
    check(decision == expected, "navigation(\(text)) is \(String(describing: decision)), expected \(expected)")
}

check(CloudPanePolicy.googleSignInMessage
        == "Google sign-in doesn't work inside lu-minal. Use 'Continue with email' (Claude sends you a code).",
      "the Google sign-in message")

// MARK: - Download names

do {
    let folder = URL(fileURLWithPath: "/Users/me/Downloads", isDirectory: true)
    var taken: Set<String> = ["report.pdf", "report (2).pdf", "download", "archive.tar.gz"]
    let exists: (URL) -> Bool = { taken.contains($0.lastPathComponent) }
    func name(_ suggested: String) -> String {
        let url = CloudPanePolicy.downloadDestination(in: folder, suggested: suggested, exists: exists)
        check(url.deletingLastPathComponent().path == folder.path, "\(suggested) stays in the folder: \(url.path)")
        return url.lastPathComponent
    }
    check(name("notes.md") == "notes.md", "a free name")
    check(name("report.pdf") == "report (3).pdf", "a taken name gets a number")
    check(name("../../etc/passwd") == "passwd", "no way out of the folder")
    check(name(".bashrc") == "bashrc", "no hidden files")
    check(name("") == "download (2)", "an empty name")
    check(name("   ") == "download (2)", "a blank name")
    check(name("archive.tar.gz") == "archive.tar (2).gz", "the last extension stays")
    check(name("README") == "README", "no extension")
    taken.insert("README")
    check(name("README") == "README (2)", "no extension, taken")
}

print("\(checks) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
