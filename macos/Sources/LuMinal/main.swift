// The lu-minal app's entry point. Started with --lu-minal-print-env (by the login shell, see
// ShellEnvironment.swift) it only prints its environment; otherwise it runs the AppKit app.
import AppKit

if CommandLine.arguments.contains(ShellEnvironment.printFlag) {
    ShellEnvironment.printCurrentEnvironment()
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
