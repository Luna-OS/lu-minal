//! lu-minal's private OSC sequence for the cloud pane: `ESC ] 7701 ; <command> [; <argument>] BEL`
//! (or ST, `ESC \`, as the terminator). The filter takes these sequences out of the PTY output
//! before xterm.js sees it and hands their commands to the host; every other byte, other OSC
//! sequences included, goes through untouched and in order. A sequence may be split across reads
//! at any offset. One whose payload is longer than [`MAX_PAYLOAD`] bytes is swallowed and dropped.
//!
//! Commands: `open;<url>` (the URL must pass [`crate::urls::pane_url`]), `show`, `hide`,
//! `toggle`. Unknown commands, payloads that are not UTF-8 and refused URLs are ignored. Any
//! program running in the terminal can print the sequence, so the URL check is the boundary.

use crate::urls;

/// The longest payload (the bytes between `7701;` and the terminator) that is still read.
pub const MAX_PAYLOAD: usize = 4096;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
/// CAN and SUB end any escape sequence in xterm (and xterm.js) without running it.
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

/// What the introducer looks like up to its number: `ESC ] 7 7 0 1`.
const INTRODUCER: &[u8] = b"\x1b]7701";

/// A command for the cloud pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneCommand {
    /// Show the pane and load this (checked) URL.
    Open(String),
    /// Show the pane (keeping its page, or claude.ai/code the first time).
    Show,
    Hide,
    Toggle,
}

/// Reads a payload (`open;https://claude.ai/code`, `show`, ...) into a command.
pub fn parse_command(payload: &[u8]) -> Option<PaneCommand> {
    let text = std::str::from_utf8(payload).ok()?;
    let (command, argument) = match text.split_once(';') {
        Some((c, a)) => (c, Some(a)),
        None => (text, None),
    };
    match command {
        "open" => urls::pane_url(argument?).map(PaneCommand::Open),
        "show" => Some(PaneCommand::Show),
        "hide" => Some(PaneCommand::Hide),
        "toggle" => Some(PaneCommand::Toggle),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// Passing bytes through.
    Ground,
    /// `matched` bytes of [`INTRODUCER`] seen (1 ..= INTRODUCER.len()), held back.
    Introducer { matched: usize },
    /// Inside our payload, collecting it.
    Payload,
    /// Inside our payload, an ESC seen: `\` ends the sequence, anything else cancels it.
    PayloadEsc,
    /// Inside a payload that grew too long: swallowing it up to the terminator.
    Discard,
    /// Inside a discarded payload, an ESC seen.
    DiscardEsc,
}

/// The streaming filter: feed it every chunk of PTY output in order.
#[derive(Debug)]
pub struct OscFilter {
    state: State,
    payload: Vec<u8>,
}

impl Default for OscFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl OscFilter {
    pub fn new() -> Self {
        Self { state: State::Ground, payload: Vec::new() }
    }

    /// Filters one chunk: appends what the terminal should see to `out` and the complete
    /// commands to `commands`. Bytes that may still turn out to be a sequence of ours (a chunk
    /// that ends in `ESC ] 77`, say) are held back until the next chunk shows what they are.
    pub fn feed(&mut self, input: &[u8], out: &mut Vec<u8>, commands: &mut Vec<PaneCommand>) {
        let mut i = 0;
        while i < input.len() {
            let b = input[i];
            match self.state {
                State::Ground => {
                    // Copy everything up to the next ESC in one go.
                    match input[i..].iter().position(|&c| c == ESC) {
                        Some(at) => {
                            out.extend_from_slice(&input[i..i + at]);
                            i += at + 1;
                            self.state = State::Introducer { matched: 1 };
                        }
                        None => {
                            out.extend_from_slice(&input[i..]);
                            i = input.len();
                        }
                    }
                }
                State::Introducer { matched } => {
                    if matched < INTRODUCER.len() {
                        if b == INTRODUCER[matched] {
                            self.state = State::Introducer { matched: matched + 1 };
                            i += 1;
                        } else {
                            // Not ours: give back what was held and look at this byte afresh
                            // (it may be the ESC of the next sequence).
                            out.extend_from_slice(&INTRODUCER[..matched]);
                            self.state = State::Ground;
                        }
                    } else {
                        // `ESC ] 7701` complete: a `;` (or the end right away) makes it ours;
                        // anything else (`ESC ] 77011;...`) is another OSC.
                        match b {
                            b';' => {
                                self.payload.clear();
                                self.state = State::Payload;
                                i += 1;
                            }
                            BEL => {
                                self.payload.clear();
                                self.state = State::Ground;
                                i += 1;
                            }
                            ESC => {
                                self.payload.clear();
                                self.state = State::PayloadEsc;
                                i += 1;
                            }
                            _ => {
                                out.extend_from_slice(INTRODUCER);
                                self.state = State::Ground;
                            }
                        }
                    }
                }
                State::Payload => {
                    // Collect up to the next byte that ends (or may end) the payload.
                    let rest = &input[i..];
                    let stop = rest.iter().position(|&c| matches!(c, BEL | ESC | CAN | SUB));
                    let take = stop.unwrap_or(rest.len());
                    if self.payload.len() + take > MAX_PAYLOAD {
                        self.payload.clear();
                        self.state = State::Discard;
                        continue;
                    }
                    self.payload.extend_from_slice(&rest[..take]);
                    i += take;
                    let Some(_) = stop else { continue };
                    let end = input[i];
                    i += 1;
                    match end {
                        BEL => self.finish(commands),
                        ESC => self.state = State::PayloadEsc,
                        _ => self.cancel(),
                    }
                }
                State::PayloadEsc => {
                    if b == b'\\' {
                        i += 1;
                        self.finish(commands);
                    } else {
                        // ESC starts something new: the sequence is cancelled, and the ESC
                        // (already consumed) is looked at again with this byte.
                        self.cancel();
                        self.state = State::Introducer { matched: 1 };
                    }
                }
                State::Discard => {
                    let rest = &input[i..];
                    match rest.iter().position(|&c| matches!(c, BEL | ESC | CAN | SUB)) {
                        Some(at) => {
                            let end = rest[at];
                            i += at + 1;
                            self.state = if end == ESC { State::DiscardEsc } else { State::Ground };
                        }
                        None => i = input.len(),
                    }
                }
                State::DiscardEsc => {
                    if b == b'\\' {
                        i += 1;
                        self.state = State::Ground;
                    } else {
                        self.state = State::Introducer { matched: 1 };
                    }
                }
            }
        }
    }

    /// Gives back bytes held at the end of the output (the program ended in the middle of an
    /// introducer). A payload that never ended is dropped.
    pub fn flush(&mut self, out: &mut Vec<u8>) {
        if let State::Introducer { matched } = self.state {
            out.extend_from_slice(&INTRODUCER[..matched]);
        }
        self.payload.clear();
        self.state = State::Ground;
    }

    /// Whether bytes are held back (the caller may flush them after a pause).
    pub fn holding(&self) -> bool {
        matches!(self.state, State::Introducer { .. })
    }

    fn finish(&mut self, commands: &mut Vec<PaneCommand>) {
        if let Some(command) = parse_command(&self.payload) {
            commands.push(command);
        }
        self.cancel();
    }

    fn cancel(&mut self) {
        self.payload.clear();
        self.state = State::Ground;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&[u8]]) -> (Vec<u8>, Vec<PaneCommand>) {
        let mut filter = OscFilter::new();
        let mut out = Vec::new();
        let mut commands = Vec::new();
        for chunk in chunks {
            filter.feed(chunk, &mut out, &mut commands);
        }
        filter.flush(&mut out);
        (out, commands)
    }

    /// Feeds `input` split at every possible pair of offsets and checks the result never changes.
    fn every_split(input: &[u8]) -> (Vec<u8>, Vec<PaneCommand>) {
        let whole = run(&[input]);
        for a in 0..=input.len() {
            for b in a..=input.len() {
                assert_eq!(run(&[&input[..a], &input[a..b], &input[b..]]), whole, "split at {a} and {b}");
            }
        }
        // One byte at a time.
        let bytes: Vec<&[u8]> = input.chunks(1).collect();
        assert_eq!(run(&bytes), whole, "byte by byte");
        whole
    }

    #[test]
    fn removes_the_sequence_and_reads_the_command() {
        let (out, commands) = every_split(b"before\x1b]7701;open;https://claude.ai/code/session_1\x07after");
        assert_eq!(out, b"beforeafter");
        assert_eq!(commands, vec![PaneCommand::Open("https://claude.ai/code/session_1".into())]);
    }

    #[test]
    fn accepts_st_as_terminator() {
        let (out, commands) = every_split(b"a\x1b]7701;show\x1b\\b\x1b]7701;hide\x07c\x1b]7701;toggle\x1b\\");
        assert_eq!(out, b"abc");
        assert_eq!(commands, vec![PaneCommand::Show, PaneCommand::Hide, PaneCommand::Toggle]);
    }

    #[test]
    fn leaves_other_osc_sequences_and_escapes_alone() {
        let input: &[u8] = b"\x1b]0;lu-minal\x07\x1b]8;;https://x.dev\x1b\\link\x1b]8;;\x1b\\\x1b[31mred\x1b[0m\x1b]77011;x\x07\x1b]770;y\x07\x1b]52;c;aGk=\x07\x1b\x1b]7701;show\x07";
        let (out, commands) = every_split(input);
        let mut expected = input.to_vec();
        expected.truncate(input.len() - b"\x1b]7701;show\x07".len());
        assert_eq!(out, expected);
        assert_eq!(commands, vec![PaneCommand::Show]);
    }

    #[test]
    fn keeps_utf8_split_around_sequences_intact() {
        let input = "moon \u{1f319} \x1b]7701;show\x07 \u{2728} end".as_bytes();
        let (out, commands) = every_split(input);
        assert_eq!(String::from_utf8(out).unwrap(), "moon \u{1f319}  \u{2728} end");
        assert_eq!(commands, vec![PaneCommand::Show]);
    }

    #[test]
    fn ignores_unknown_commands_and_refused_urls_but_still_removes_them() {
        let (out, commands) = every_split(
            b"1\x1b]7701;launch;calc.exe\x072\x1b]7701;open;https://evil.example/\x073\x1b]7701;open;http://claude.ai/\x074\x1b]7701;open\x075\x1b]7701;\x076\x1b]7701\x077\x1b]7701;\xff\xfe\x07",
        );
        assert_eq!(out, b"1234567");
        assert!(commands.is_empty(), "{commands:?}");
    }

    #[test]
    fn drops_a_payload_longer_than_the_limit_and_resumes_after_it() {
        let mut long = b"x\x1b]7701;open;https://claude.ai/".to_vec();
        long.extend(std::iter::repeat_n(b'a', MAX_PAYLOAD));
        long.extend_from_slice(b"\x07y\x1b]7701;show\x07z");
        let (out, commands) = run(&[&long]);
        assert_eq!(out, b"xyz");
        assert_eq!(commands, vec![PaneCommand::Show]);
        // Split into small chunks: the same.
        let chunks: Vec<&[u8]> = long.chunks(7).collect();
        assert_eq!(run(&chunks), (b"xyz".to_vec(), vec![PaneCommand::Show]));
    }

    #[test]
    fn a_payload_exactly_at_the_limit_is_still_read() {
        let mut url = String::from("https://claude.ai/code?");
        let prefix = "open;".len();
        while prefix + url.len() < MAX_PAYLOAD {
            url.push('q');
        }
        let input = format!("\x1b]7701;open;{url}\x07");
        let (out, commands) = run(&[input.as_bytes()]);
        assert!(out.is_empty());
        assert_eq!(commands, vec![PaneCommand::Open(url)]);
    }

    #[test]
    fn cancels_on_can_sub_and_a_new_escape() {
        let (out, commands) = every_split(b"a\x1b]7701;show\x18b\x1b]7701;show\x1ac\x1b]7701;show\x1b[1md\x1b]7701;hide\x07");
        // CAN / SUB are swallowed with the sequence; a new ESC starts its own sequence.
        assert_eq!(out, b"abc\x1b[1md");
        assert_eq!(commands, vec![PaneCommand::Hide]);
    }

    #[test]
    fn gives_back_a_held_introducer_at_the_end() {
        let mut filter = OscFilter::new();
        let mut out = Vec::new();
        let mut commands = Vec::new();
        filter.feed(b"text\x1b]77", &mut out, &mut commands);
        assert_eq!(out, b"text");
        assert!(filter.holding());
        filter.flush(&mut out);
        assert_eq!(out, b"text\x1b]77");
        assert!(!filter.holding());
        // A lone ESC at the end of a chunk is held, then given back with what follows.
        filter.feed(b"\x1b", &mut out, &mut commands);
        filter.feed(b"[2J", &mut out, &mut commands);
        assert_eq!(out, b"text\x1b]77\x1b[2J");
    }

    #[test]
    fn parses_payloads() {
        assert_eq!(parse_command(b"show"), Some(PaneCommand::Show));
        assert_eq!(parse_command(b"show;extra"), Some(PaneCommand::Show));
        assert_eq!(parse_command(b"open;https://claude.ai/code"), Some(PaneCommand::Open("https://claude.ai/code".into())));
        assert_eq!(parse_command(b"open;https://claude.ai/a;b"), Some(PaneCommand::Open("https://claude.ai/a;b".into())));
        assert_eq!(parse_command(b"Show"), None);
        assert_eq!(parse_command(b""), None);
        assert_eq!(parse_command(b"open;"), None);
    }
}
