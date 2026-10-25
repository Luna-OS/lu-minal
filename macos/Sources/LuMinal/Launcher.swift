// What a session runs: the lu-minal binary bundled at Contents/Resources/bin/lu-minal, or, in a
// build without one, lu-minal from the login shell's PATH (Homebrew, npm, ~/.local/bin) through
// `/bin/zsh -lc`. Either way with TERM=xterm-256color, COLORTERM=truecolor and a UTF-8 locale.
import Foundation

struct LaunchCommand {
    let executable: String
    let args: [String]
    let execName: String?
    /// "KEY=value" entries, as SwiftTerm's startProcess takes them.
    let environment: [String]
    let currentDirectory: String
}

enum Launcher {
    /// Runs lu-minal from the PATH, or explains how to install it. $0 is "lu-minal", "$@" its arguments.
    static let pathScript = #"""
    if command -v lu-minal >/dev/null 2>&1; then
      exec lu-minal "$@"
    fi
    printf '\r\n  \033[38;2;242;139;146mlu-minal was not found.\033[0m\r\n\r\n'
    printf '  This build of the app has no lu-minal inside, and there is none on your PATH.\r\n'
    printf '  Install it with one of these, then press Cmd+N:\r\n\r\n'
    printf '    curl -fsSL https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.sh | sh\r\n'
    printf '    npm i -g lu-minal\r\n\r\n'
    exit 127
    """#

    /// Variables that belong to the terminal the app may have been started from, not to this one.
    static let foreignTerminalVariables = [
        "TERM_SESSION_ID", "ITERM_SESSION_ID", "ITERM_PROFILE", "WT_SESSION", "WT_PROFILE_ID",
        "KITTY_WINDOW_ID", "WEZTERM_EXECUTABLE", "WEZTERM_PANE", "ALACRITTY_WINDOW_ID",
        "GHOSTTY_RESOURCES_DIR", "VSCODE_INJECTION", "TMUX", "TMUX_PANE", "STY",
    ]

    /// The app's version (CFBundleShortVersionString), "dev" when run with `swift run`.
    static var appVersion: String {
        return (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "dev"
    }

    /// The lu-minal binary inside the app bundle, if this build has one.
    static func bundledBinary() -> String? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let path = resources.appendingPathComponent("bin").appendingPathComponent("lu-minal").path
        return FileManager.default.isExecutableFile(atPath: path) ? path : nil
    }

    /// The command for a session in `folder` (nil: the home folder) with the login shell's environment.
    static func command(folder: URL?, environment base: [String: String]) -> LaunchCommand {
        var env = base
        for key in foreignTerminalVariables {
            env.removeValue(forKey: key)
        }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "lu-minal"
        env["TERM_PROGRAM_VERSION"] = appVersion
        env["LU_MINAL_APP"] = "1"
        if (env["LANG"] ?? "").isEmpty {
            env["LANG"] = "en_US.UTF-8"
        }
        env["PATH"] = ShellEnvironment.withCommonPaths(env["PATH"])
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        if (env["HOME"] ?? "").isEmpty {
            env["HOME"] = home
        }

        var isDir: ObjCBool = false
        var directory = home
        var args: [String] = []
        if let folder = folder, FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDir), isDir.boolValue {
            directory = folder.path
            args = [folder.path]
        }
        env["PWD"] = directory
        let list = env.map { "\($0.key)=\($0.value)" }.sorted()

        if let binary = bundledBinary() {
            return LaunchCommand(executable: binary, args: args, execName: nil, environment: list, currentDirectory: directory)
        }
        return LaunchCommand(
            executable: "/bin/zsh",
            args: ["-lc", pathScript, "lu-minal"] + args,
            execName: nil,
            environment: list,
            currentDirectory: directory
        )
    }
}
