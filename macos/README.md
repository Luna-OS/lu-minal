# lu-minal for macOS

A native macOS app that runs lu-minal in its own window, in the Moon look: a transparent title bar
over the night sky (`night-950 #0b0920`), the Moon terminal palette with a moonlight-gold cursor,
and SF Mono 13. It is written in Swift with AppKit and [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm),
and true colour works out of the box (Terminal.app before macOS 26 only has 256 colours).

- One window per lu-minal session: **Cmd+N** opens a new one, **Cmd+O** (File > Open Folder...)
  opens one in a project folder, **Cmd+W** closes it (it asks first while lu-minal is running),
  **Cmd+Q** quits.
- **Cmd+=**, **Cmd+-** and **Cmd+0** change the font size (remembered for new windows).
- Copy and paste with **Cmd+C** / **Cmd+V** (Edit menu); select text with the mouse.
- **View > Use Option as Meta Key** makes Option send Alt shortcuts (`alt+1` ... `alt+9` for tabs).
  It is off by default, because on many keyboard layouts Option types `@`, `[`, `]`, `{` and `}`.
  Every lu-minal shortcut also has a slash command.
- Folders dropped on the Dock icon (or on LuMinal.app in the Finder) start a session there. So do
  `open -a LuMinal ~/code/app` and `open -a LuMinal --args ~/code/app`.
- When lu-minal exits, the window says so: press any key to close it, or Cmd+N for a new session.
- **Cmd+Shift+K** (View > Cloud Pane, or the cloud button at the right of the title bar) shows the
  [cloud pane](#the-cloud-pane): the claude.ai website with your Claude Code cloud sessions, beside
  the terminal in the same window.

## The cloud pane

The cloud pane shows the real website, [claude.ai/code](https://claude.ai/code), in a native web
view (WebKit, as in Safari) to the right of the terminal. It is your own logged-in view of
claude.ai; the app only displays it. It puts no scripts into the page, reads nothing from it
(no page content, cookies or storage) and keeps WebKit's own user agent.

- **Show and hide it** with **Cmd+Shift+K**, View > Cloud Pane, or the cloud button in the title
  bar. The key never reaches lu-minal or the page. The header's buttons go back, reload, open the
  current page in your default browser, and close the pane.
- **Resize it** by dragging the line between the terminal and the pane; the terminal (and
  lu-minal) gets the room that is left. The app remembers the width and whether the pane is open.
  It is closed until you first open it.
- **Sign in once**, inside the pane, with **Continue with email**: claude.ai sends you a code,
  which you type into the pane. The sign-in is kept between runs. **Google sign-in doesn't work**
  there (Google refuses sign-ins in embedded web views), so the pane stops it and says so.
- **Links**: pages on claude.ai, `*.anthropic.com` and the Cloudflare check claude.ai shows open
  in the pane. Everything else (GitHub, docs elsewhere, a page you Command-click) opens in your
  default browser, and so do sign-in pages of other sites (single sign-on, for example). As in
  Safari, a page can only open a new window (or browser tab) when you click or type, never on its
  own.
- **Files**: uploads (the page's file picker) open the standard Open panel; downloads go to your
  Downloads folder. Camera and microphone requests are refused.
- **Where the sign-in is kept**: in WebKit's data store for this app, in your Library folder under
  the app's bundle id `os.luna.lu-minal` (mainly `~/Library/WebKit/os.luna.lu-minal` and, for the
  cookies, `~/Library/HTTPStorages/os.luna.lu-minal`). Every window's pane shares it.
- **Sign out**: View > **Sign Out of the Cloud Pane...** removes the pane's cookies and website
  data from this Mac, and the pane goes back to the sign-in page. Your cloud sessions keep running.

lu-minal can open the pane too. The app starts it with `LU_MINAL_WEB_PANE=1`, and lu-minal writes
a private escape sequence, `ESC ] 7701 ; <command> [; <argument>] BEL` (or ST instead of BEL):
`open;<url>` shows the pane with that page, `show` shows it (keeping its page), `hide` and
`toggle`. The app takes these sequences out of lu-minal's output before the terminal sees them,
ignores unknown commands and sequences longer than 4096 bytes, and `open` only loads `https`
pages on `claude.ai` or its subdomains: any program running in the terminal could print the
sequence, so that check is what keeps the pane on claude.ai.

## Install

Download `lu-minal-macos-app.zip` (or `.dmg`) from the
[releases](https://github.com/Luna-OS/lu-minal/releases/latest), unzip it and move `LuMinal.app`
to `/Applications`.

Release builds are signed ad-hoc, not with an Apple Developer ID, so Gatekeeper stops the first
start with "LuMinal can't be opened because Apple cannot check it for malicious software":

- **Right-click (or Control-click) LuMinal.app > Open**, then **Open** in the dialog. macOS
  remembers the choice; from then on it starts normally.
- On macOS 15 and later the dialog may only offer "Done": open **System Settings > Privacy &
  Security**, scroll down to "LuMinal was blocked" and click **Open Anyway**.
- Or, in a terminal: `xattr -dr com.apple.quarantine /Applications/LuMinal.app`

The app contains its own lu-minal (`LuMinal.app/Contents/Resources/bin/lu-minal`, a universal
arm64 + x86_64 binary), so nothing else needs to be installed. A build without it runs the
`lu-minal` on your PATH instead (`install.sh`, or a build from source:
https://github.com/Luna-OS/lu-minal#from-source).

## How it starts lu-minal

Apps opened from the Finder or the Dock get launchd's bare environment
(`PATH=/usr/bin:/bin:/usr/sbin:/sbin`), where lu-minal would not find `claude`, Homebrew's `git`
or nvm's `node`. So, like Terminal.app and VS Code, the app asks your login shell once for its
environment (`$SHELL -i -l -c '<app> --lu-minal-print-env'`, with a timeout) and starts every
session with it, plus:

- `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=lu-minal`, `LU_MINAL_APP=1`,
  `LU_MINAL_WEB_PANE=1` (the window has a cloud pane)
- `LANG=en_US.UTF-8` if your shell sets no locale
- the usual tool folders on `PATH` when missing (`~/.local/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.bun/bin`, `~/.claude/local`, ...)

It runs the bundled binary directly, in your home folder or the folder you opened (which is also
passed to lu-minal as its first argument). Without a bundled binary it runs
`/bin/zsh -lc 'exec lu-minal "$@"'`.

## Build it yourself

You need macOS 13 or later, Xcode 16 (or newer) or its command line tools, and
[Bun](https://bun.sh) for the lu-minal binary. From the repository root:

```sh
npm ci
bun scripts/build-binaries.ts --target=macos          # dist-bin/lu-minal-macos-arm64 and -x64
bash macos/scripts/bundle-app.sh \
  --binary dist-bin/lu-minal-macos-arm64 --binary dist-bin/lu-minal-macos-x64
open macos/build/LuMinal.app
```

`bundle-app.sh` builds the Swift package in release mode (universal arm64 + x86_64 when the
toolchain can, otherwise for your Mac), assembles `LuMinal.app` (`Contents/MacOS/LuMinal`,
`Contents/Resources/bin/lu-minal` - the two binaries combined with `lipo` - `Info.plist` and
`AppIcon.icns`, drawn by `scripts/make-icon.swift` and converted with `sips` and `iconutil`), signs
it ad-hoc (`codesign --force --deep -s -`) and zips it with `ditto`
(`macos/build/lu-minal-macos-app.zip`). Options: `--dmg` for a disk image, `--arch arm64|x86_64|native`,
`--version`, `--out`, `--no-zip`, `--icon <png>`.

To sign with a Developer ID instead (for notarization), set
`LU_MINAL_SIGN_IDENTITY="Developer ID Application: ..."`: the app is then signed with the hardened
runtime, and the lu-minal binary with `entitlements/lu-minal-binary.entitlements` (Bun's JIT
needs them). Notarize the zip with `xcrun notarytool submit ... --wait` and staple the app. The
cloud pane needs no entitlement: the app is not sandboxed, and WebKit's web content and network
processes are the system's own.

For quick iterations, `swift run --package-path macos` starts the app straight from the build
folder (it uses the lu-minal on your PATH; its cloud pane keeps its data under the name
`LuMinal` instead of the bundle id).

`bash macos/scripts/test-pane.sh` checks the cloud pane's escape-sequence filter and URL policy
(`Tests/PaneTests`). Those two files are plain Swift and Foundation, so it needs only `swiftc`
and also runs on Linux with the Swift toolchain (`SWIFTC=/path/to/swiftc`). CI runs it before it
builds the app.

## Layout

| File | |
| --- | --- |
| `Package.swift` | Swift package: the `LuMinal` executable, macOS 13+, SwiftTerm |
| `Sources/LuMinal/main.swift` | Entry point (and the `--lu-minal-print-env` mode) |
| `Sources/LuMinal/AppDelegate.swift` | Menus, sessions, Open Folder, font size, Option as Meta, Cmd+Shift+K, sign-out |
| `Sources/LuMinal/SessionWindowController.swift` | One Moon window with its terminal, process and cloud pane |
| `Sources/LuMinal/SessionContentView.swift` | The window's layout: terminal, divider, cloud pane |
| `Sources/LuMinal/MoonTerminalView.swift` | SwiftTerm view (OSC 7701, key after exit), the night-sky container |
| `Sources/LuMinal/CloudPaneView.swift` | The cloud pane: WKWebView, header, notices, uploads, downloads |
| `Sources/LuMinal/CloudPanePolicy.swift` | Where the pane may go: `open` URLs, links, Google sign-in (Foundation only) |
| `Sources/LuMinal/PaneSequenceFilter.swift` | Takes OSC 7701 out of lu-minal's output (plain Swift) |
| `Sources/LuMinal/MoonPalette.swift` | The Moon palette and the font (mirrors `src/platform/windows-terminal.ts`) |
| `Sources/LuMinal/Launcher.swift` | What a session runs: bundled binary or PATH, its environment |
| `Sources/LuMinal/ShellEnvironment.swift` | The login shell's environment |
| `Tests/PaneTests/main.swift` | Checks for the filter and the policy (`scripts/test-pane.sh`) |
| `Resources/Info.plist` | Bundle metadata (`os.luna.lu-minal`, macOS 13+, folders as documents) |
| `scripts/bundle-app.sh` | Builds, assembles, signs and archives `LuMinal.app` |
| `scripts/test-pane.sh` | Compiles and runs `Tests/PaneTests` with `swiftc` |
| `scripts/make-icon.swift` | Draws the app icon (same design as `linux/lu-minal.svg`) |

## SwiftTerm version

`Package.swift` pins SwiftTerm to 1.10.x on purpose. 1.10 builds with Swift tools 5.9 and has no
resources or build plugins, so any Xcode from 15 on compiles it. Later releases add a Metal shader
resource (1.12+, which newer Xcode versions want to compile with the separately installed Metal
toolchain), require Swift tools 6.0 (1.20) or 6.2 (1.99+), and 1.99 changed its delegate protocols
to `@MainActor`. The app only uses API that is the same from 1.10 to 1.99
(`LocalProcessTerminalView`, `startProcess(executable:args:environment:execName:currentDirectory:)`,
the four `LocalProcessTerminalViewDelegate` methods, `installColors`, the native colour and font
properties), so moving forward is a one-line change - check that CI's Xcode builds it.

One more thing to check then: the cloud pane's escape sequences are taken out of lu-minal's
output in `MoonTerminalView.dataReceived(slice:)`, which overrides the `open` method through which
1.10's `LocalProcess` hands the terminal what it reads. SwiftTerm's main branch delivers that data
through an internal adapter instead, past that method; on such a version, find the new place
where the output arrives (or the `Terminal.registerOscHandler(code:handler:)` hook) before
moving.
