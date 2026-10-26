// The private escape sequence lu-minal talks to the window's cloud pane with, and the filter that
// takes it out of lu-minal's output before SwiftTerm sees it:
//
//     ESC ] 7701 ; <command> [; <argument>] BEL        (or ST, ESC \, instead of BEL)
//
// Commands: "open;<url>" shows the pane and loads <url>, "show" shows it (keeping its page),
// "hide" and "toggle". Unknown commands are ignored, and so is a sequence longer than 4096 bytes.
// Any program running in the terminal can print the sequence, so the URL check
// (CloudPanePolicy.paneURL) is what keeps the pane on claude.ai.
//
// Plain Swift (no Foundation, no AppKit), so macos/Tests/PaneTests can run it on any machine.

/// A command for the cloud pane, as lu-minal sent it.
enum PaneCommand: Equatable {
    /// Show the pane and load this URL (not checked yet: see CloudPanePolicy.paneURL).
    case open(String)
    /// Show the pane, keeping its page (the home page the first time).
    case show
    case hide
    case toggle
}

/// Takes OSC 7701 sequences out of a byte stream that arrives in chunks of any size (a sequence may
/// be split anywhere) and passes everything else through unchanged and in order. Other escape
/// sequences (OSC 0 titles, OSC 8 links, CSI, ...) and UTF-8 text are not touched.
struct PaneSequenceFilter {
    /// What starts a sequence of ours: ESC ] 7 7 0 1.
    static let introducer: [UInt8] = [0x1b, 0x5d, 0x37, 0x37, 0x30, 0x31]
    /// The longest sequence, from ESC to the end of its terminator, that is carried out.
    static let maxSequenceLength = 4096

    struct Output {
        /// The bytes for the terminal.
        var bytes: ArraySlice<UInt8>
        /// The commands found in this chunk, in order.
        var commands: [PaneCommand]
    }

    private enum State: Equatable {
        /// Ordinary output.
        case text
        /// The first `n` bytes of the introducer arrived. They are held back until it is clear
        /// whether this is a sequence of ours; if not, they go out after all.
        case introducer(Int)
        /// Inside a sequence of ours.
        case payload
        /// Inside a sequence of ours, right after an ESC (ST, or the sequence breaking off).
        case payloadEscape
    }

    private var state = State.text
    private var payload: [UInt8] = []
    /// Bytes of the current sequence so far, from its ESC on (stops counting past the maximum).
    private var length = 0

    init() {}

    /// Filters the next chunk of output.
    mutating func filter(_ input: ArraySlice<UInt8>) -> Output {
        // The common case: text without an ESC, and nothing held back from the last chunk.
        if state == .text && !input.contains(0x1b) {
            return Output(bytes: input, commands: [])
        }
        var out: [UInt8] = []
        out.reserveCapacity(input.count + PaneSequenceFilter.introducer.count)
        var commands: [PaneCommand] = []
        var i = input.startIndex
        while i < input.endIndex {
            switch state {
            case .text:
                guard let escape = input[i...].firstIndex(of: 0x1b) else {
                    out.append(contentsOf: input[i...])
                    i = input.endIndex
                    break
                }
                out.append(contentsOf: input[i..<escape])
                state = .introducer(1)
                i = escape + 1

            case .introducer(let held) where held < PaneSequenceFilter.introducer.count:
                if input[i] == PaneSequenceFilter.introducer[held] {
                    state = .introducer(held + 1)
                    i += 1
                } else {
                    // Not ours: the held bytes go out, and this byte is looked at again as text (it
                    // may be the ESC of the next sequence).
                    out.append(contentsOf: PaneSequenceFilter.introducer[0..<held])
                    state = .text
                }

            case .introducer:
                // "ESC ] 7701" so far: ours only if ";" or a terminator follows (OSC 77010 is not).
                switch input[i] {
                case 0x3b: // ;
                    begin()
                    state = .payload
                    i += 1
                case 0x07: // BEL: a sequence without a command
                    begin()
                    finish(into: &commands)
                    state = .text
                    i += 1
                case 0x1b: // ESC: ST, or the sequence breaking off
                    begin()
                    state = .payloadEscape
                    i += 1
                default:
                    out.append(contentsOf: PaneSequenceFilter.introducer)
                    state = .text
                }

            case .payload:
                let byte = input[i]
                i += 1
                count()
                switch byte {
                case 0x07: // BEL
                    finish(into: &commands)
                    state = .text
                case 0x1b:
                    state = .payloadEscape
                case 0x18, 0x1a: // CAN, SUB: the sequence is cancelled
                    payload.removeAll(keepingCapacity: true)
                    state = .text
                case 0x00..<0x20:
                    // Other C0 controls are ignored inside the sequence, as terminals do in an OSC.
                    break
                default:
                    if payload.count < PaneSequenceFilter.maxSequenceLength {
                        payload.append(byte)
                    }
                }

            case .payloadEscape:
                if input[i] == 0x5c { // ESC \ (ST)
                    i += 1
                    count()
                    finish(into: &commands)
                    state = .text
                } else {
                    // Not ST: the sequence breaks off unfinished (and is not carried out), and the
                    // ESC starts whatever follows.
                    payload.removeAll(keepingCapacity: true)
                    state = .introducer(1)
                }
            }
        }
        return Output(bytes: out[...], commands: commands)
    }

    /// Starts a sequence of ours after its introducer and the byte that follows it.
    private mutating func begin() {
        payload.removeAll(keepingCapacity: true)
        length = PaneSequenceFilter.introducer.count + 1
    }

    private mutating func count() {
        if length <= PaneSequenceFilter.maxSequenceLength {
            length += 1
        }
    }

    /// Ends the current sequence; carries it out unless it was too long or is not a command.
    private mutating func finish(into commands: inout [PaneCommand]) {
        if length <= PaneSequenceFilter.maxSequenceLength, let command = PaneSequenceFilter.command(from: payload) {
            commands.append(command)
        }
        payload.removeAll(keepingCapacity: true)
    }

    /// The command in a sequence's payload ("open;https://claude.ai/code", "show", ...), or nil.
    /// Only the first ";" separates the command from its argument, so URLs may contain ";".
    static func command(from payload: [UInt8]) -> PaneCommand? {
        var name = payload[...]
        var argument: ArraySlice<UInt8>?
        if let separator = payload.firstIndex(of: 0x3b) {
            name = payload[..<separator]
            argument = payload[(separator + 1)...]
        }
        switch String(decoding: name, as: UTF8.self) {
        case "open":
            guard let argument = argument, !argument.isEmpty else { return nil }
            return .open(String(decoding: argument, as: UTF8.self))
        case "show":
            return .show
        case "hide":
            return .hide
        case "toggle":
            return .toggle
        default:
            return nil
        }
    }
}
