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
`lu-minal` on your PATH instead (`npm i -g lu-minal` or `install.sh`).

## How it starts lu-minal

Apps opened from the Finder or the Dock get launchd's bare environment
(`PATH=/usr/bin:/bin:/usr/sbin:/sbin`), where lu-minal would not find `claude`, Homebrew's `git`
or nvm's `node`. So, like Terminal.app and VS Code, the app asks your login shell once for its
environment (`$SHELL -i -l -c '<app> --lu-minal-print-env'`, with a timeout) and starts every
session with it, plus:

- `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=lu-minal`, `LU_MINAL_APP=1`
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
needs them). Notarize the zip with `xcrun notarytool submit ... --wait` and staple the app.

For quick iterations, `swift run --package-path macos` starts the app straight from the build
folder (it uses the lu-minal on your PATH).

## Layout

| File | |
| --- | --- |
| `Package.swift` | Swift package: the `LuMinal` executable, macOS 13+, SwiftTerm |
| `Sources/LuMinal/main.swift` | Entry point (and the `--lu-minal-print-env` mode) |
| `Sources/LuMinal/AppDelegate.swift` | Menus, sessions, Open Folder, font size, Option as Meta |
| `Sources/LuMinal/SessionWindowController.swift` | One Moon window with its terminal and process |
| `Sources/LuMinal/MoonTerminalView.swift` | SwiftTerm view (key after exit), the night-sky container |
| `Sources/LuMinal/MoonPalette.swift` | The Moon palette and the font (mirrors `src/platform/windows-terminal.ts`) |
| `Sources/LuMinal/Launcher.swift` | What a session runs: bundled binary or PATH, its environment |
| `Sources/LuMinal/ShellEnvironment.swift` | The login shell's environment |
| `Resources/Info.plist` | Bundle metadata (`os.luna.lu-minal`, macOS 13+, folders as documents) |
| `scripts/bundle-app.sh` | Builds, assembles, signs and archives `LuMinal.app` |
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
