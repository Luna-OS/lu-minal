// The environment sessions start with. An app opened from the Finder or the Dock gets launchd's
// bare environment (PATH=/usr/bin:/bin:/usr/sbin:/sbin), so lu-minal would not find `claude`,
// `git` from Homebrew or `node` from nvm. Like Terminal.app (and VS Code), the app asks the user's
// login shell once: it runs `<shell> -i -l -c '<this app> --lu-minal-print-env'`, and this app,
// started that way, prints the environment it was given as JSON between two markers (whatever the
// shell's startup files print around it is ignored).
import Foundation

enum ShellEnvironment {
    /// The argument that makes the app print its environment and exit (see main.swift).
    static let printFlag = "--lu-minal-print-env"
    static let startMarker = "\u{1}LU-MINAL-ENV-START\u{1}"
    static let endMarker = "\u{1}LU-MINAL-ENV-END\u{1}"

    /// Places lu-minal and its tools usually live, added to PATH when the shell did not have them.
    static func commonPaths() -> [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "\(home)/.bun/bin",
            "\(home)/.claude/local",
            "\(home)/.volta/bin",
            "\(home)/.npm-global/bin",
        ]
    }

    /// `path` plus every existing common directory it lacks (appended, so the user's order wins).
    static func withCommonPaths(_ path: String?) -> String {
        var parts = (path ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty }
        if parts.isEmpty {
            parts = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        }
        var isDir: ObjCBool = false
        for dir in commonPaths() where !parts.contains(dir) {
            if FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue {
                parts.append(dir)
            }
        }
        return parts.joined(separator: ":")
    }

    /// The environment to use when the login shell could not be asked.
    static func fallback() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = withCommonPaths(env["PATH"])
        return env
    }

    /// Prints this process's environment as JSON between the markers (the `--lu-minal-print-env` mode).
    static func printCurrentEnvironment() {
        let env = ProcessInfo.processInfo.environment
        guard let data = try? JSONSerialization.data(withJSONObject: env, options: []),
              let json = String(data: data, encoding: .utf8),
              let out = (startMarker + json + endMarker).data(using: .utf8) else {
            return
        }
        FileHandle.standardOutput.write(out)
    }

    /// The user's login shell (from the user database, then $SHELL), or /bin/zsh.
    static func loginShell() -> String {
        if let entry = getpwuid(getuid()), let shell = entry.pointee.pw_shell {
            let path = String(cString: shell)
            if !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }
        if let shell = ProcessInfo.processInfo.environment["SHELL"], FileManager.default.isExecutableFile(atPath: shell) {
            return shell
        }
        return "/bin/zsh"
    }

    /// Quotes a word for sh, bash, zsh and fish.
    static func shellQuote(_ word: String) -> String {
        return "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// Asks the login shell for its environment in the background; `completion` runs on the main
    /// queue with the environment, or nil when the shell failed or took longer than `timeout`.
    static func resolve(timeout: TimeInterval = 8, completion: @escaping ([String: String]?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let env = load(timeout: timeout)
            DispatchQueue.main.async {
                completion(env)
            }
        }
    }

    private static func load(timeout: TimeInterval) -> [String: String]? {
        guard let selfPath = Bundle.main.executablePath else { return nil }
        var shell = loginShell()
        let name = (shell as NSString).lastPathComponent
        let command = "\(shellQuote(selfPath)) \(printFlag)"
        let arguments: [String]
        switch name {
        case "zsh", "bash", "ksh", "fish":
            arguments = ["-i", "-l", "-c", command]
        case "sh", "dash":
            arguments = ["-l", "-c", command]
        default:
            // tcsh, nushell, ...: their flags differ; zsh still reads /etc/zprofile (path_helper).
            shell = "/bin/zsh"
            arguments = ["-i", "-l", "-c", command]
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = arguments
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var env = ProcessInfo.processInfo.environment
        env["LU_MINAL_RESOLVING_ENVIRONMENT"] = "1"
        process.environment = env
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice

        let collector = OutputCollector(endMarker: Data(endMarker.utf8))
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                collector.finish()
            } else {
                collector.append(chunk)
            }
        }
        // A shell that exits without printing the markers ends the wait early. (Waiting for the
        // end marker rather than end-of-file also copes with daemons that keep the pipe open.)
        process.terminationHandler = { _ in
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) {
                collector.finish()
            }
        }
        do {
            try process.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        _ = collector.wait(timeout: timeout)
        pipe.fileHandleForReading.readabilityHandler = nil
        if process.isRunning {
            process.terminate()
        }
        return parse(collector.output())
    }

    /// Reads the JSON between the markers; nil when they are missing or the JSON is broken.
    static func parse(_ data: Data) -> [String: String]? {
        guard let text = String(data: data, encoding: .utf8),
              let start = text.range(of: startMarker, options: .backwards),
              let end = text.range(of: endMarker, range: start.upperBound..<text.endIndex) else {
            return nil
        }
        let json = Data(text[start.upperBound..<end.lowerBound].utf8)
        guard let object = try? JSONSerialization.jsonObject(with: json, options: []),
              let env = object as? [String: String],
              let path = env["PATH"], !path.isEmpty else {
            return nil
        }
        var cleaned = env
        // Variables of the throwaway shell, not of the user's session.
        for key in ["LU_MINAL_RESOLVING_ENVIRONMENT", "SHLVL", "_", "OLDPWD", "PWD"] {
            cleaned.removeValue(forKey: key)
        }
        return cleaned
    }
}

/// Collects a pipe's output and signals once the end marker arrived (or the output ended).
private final class OutputCollector: @unchecked Sendable {
    private let lock = NSLock()
    private let done = DispatchSemaphore(value: 0)
    private let endMarker: Data
    private var data = Data()
    private var finished = false

    init(endMarker: Data) {
        self.endMarker = endMarker
    }

    func append(_ chunk: Data) {
        lock.lock()
        data.append(chunk)
        let complete = data.range(of: endMarker) != nil
        lock.unlock()
        if complete {
            finish()
        }
    }

    func finish() {
        lock.lock()
        let first = !finished
        finished = true
        lock.unlock()
        if first {
            done.signal()
        }
    }

    func wait(timeout: TimeInterval) -> Bool {
        return done.wait(timeout: .now() + timeout) == .success
    }

    func output() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}
