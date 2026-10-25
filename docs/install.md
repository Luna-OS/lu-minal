# Installing lu-minal

lu-minal runs the same on **Windows, macOS and Linux**. Pick whichever fits:

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| **Setup program** | `lu-minal-windows-x64-setup.exe`, `-arm64-setup.exe` ([below](#windows-setup)) | – | – |
| **Installer** (standalone binary, no Node needed) | `irm https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.ps1 \| iex` | `curl -fsSL https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.sh \| sh` | same as macOS |
| **Download a binary** | `lu-minal-windows-x64.exe`, `-arm64.exe` | `lu-minal-macos-arm64`, `-x64` | `lu-minal-linux-x64`, `-arm64`, `-musl` builds |
| **App / integration** | Windows Terminal profile | the native **lu-minal app** (`LuMinal.app`) | applications-menu entry |
| **From source** (Node 22+) | see [below](#from-source) | see [below](#from-source) | see [below](#from-source) |

Then open a terminal in a project folder and run `lu-minal` (or `lu-minal path/to/project`).
`lu-minal --version` prints the version, `lu-minal --help` lists the sub-commands.

To sign in to Claude with your subscription, lu-minal uses the official Claude Code CLI; it
offers to install it on first use (ctrl+l). Other providers need nothing installed.

## From source

lu-minal is not published to npm yet; on a system without a release binary, or to run the newest
code, build it from a checkout. Needs Node.js 22 or newer and git:

```sh
git clone https://github.com/Luna-OS/lu-minal
cd lu-minal
npm ci
npm run build           # dist/cli.js
npm link                # puts lu-minal on your PATH; or run node dist/cli.js
```

On Windows, `npm link` installs a `lu-minal.cmd` shim into `%APPDATA%\npm`, which is on the PATH
after Node's installer. On macOS and Linux it links into npm's global `bin` folder; if that fails
with EACCES because the folder belongs to root, use a Node version manager (nvm, fnm, Volta) or
`npm config set prefix ~/.local`. To update, run `git pull`, `npm ci` and `npm run build` in the
checkout; `npm unlink -g lu-minal` removes the link.

## Standalone binaries

Every [release](https://github.com/Luna-OS/lu-minal/releases/latest) has one self-contained
executable per platform (lu-minal compiled with [Bun](https://bun.sh), about 100 MB, no Node or
anything else needed) and a `SHA256SUMS` file:

| File | For |
| --- | --- |
| `lu-minal-windows-x64.exe` | Windows 10 / 11 on Intel and AMD |
| `lu-minal-windows-arm64.exe` | Windows 11 on Arm (Snapdragon, ...) |
| `lu-minal-macos-arm64` | Macs with Apple silicon (M1 and later), macOS 13+ |
| `lu-minal-macos-x64` | Intel Macs, macOS 13+ |
| `lu-minal-linux-x64` | Linux on Intel / AMD with glibc 2.17+ (Ubuntu, Debian, Fedora, Arch, ...) |
| `lu-minal-linux-arm64` | Linux on 64-bit Arm with glibc (Raspberry Pi OS 64-bit, Graviton, ...) |
| `lu-minal-linux-x64-musl`, `lu-minal-linux-arm64-musl` | Alpine and other musl systems (`apk add libstdc++`) |
| `lu-minal-macos-app.zip`, `.dmg` | The macOS app, see below |

The x64 Linux and Windows builds run on CPUs without AVX2 too. To install one by hand:

```sh
# macOS / Linux
curl -fLO https://github.com/Luna-OS/lu-minal/releases/latest/download/lu-minal-linux-x64
curl -fLO https://github.com/Luna-OS/lu-minal/releases/latest/download/SHA256SUMS
grep ' lu-minal-linux-x64$' SHA256SUMS | sha256sum -c      # macOS: ... | shasum -a 256 -c
chmod +x lu-minal-linux-x64 && mv lu-minal-linux-x64 ~/.local/bin/lu-minal
```

```powershell
# Windows
Invoke-WebRequest https://github.com/Luna-OS/lu-minal/releases/latest/download/lu-minal-windows-x64.exe -OutFile lu-minal.exe -UseBasicParsing
(Get-FileHash lu-minal.exe -Algorithm SHA256).Hash   # compare with SHA256SUMS
```

The macOS binaries are signed ad-hoc. A binary downloaded with a browser gets the quarantine
flag; remove it with `xattr -d com.apple.quarantine lu-minal` (curl and the installer don't set it).

## install.sh (macOS and Linux)

```sh
curl -fsSL https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.sh | sh
```

It detects the OS and CPU (`uname`; Rosetta shells on Apple silicon still get the arm64 binary,
musl systems get the `-musl` build), downloads the binary and `SHA256SUMS` from the latest
release, checks the checksum (with `sha256sum`, `shasum` or `openssl`; a mismatch installs
nothing), installs it to `~/.local/bin/lu-minal` and tells you how to put that folder on your
PATH if it isn't yet. On a Linux desktop it also adds lu-minal to the applications menu.

| Variable | |
| --- | --- |
| `LU_MINAL_VERSION=0.2.0` | install that release instead of the latest |
| `LU_MINAL_INSTALL_DIR=/usr/local/bin` | install somewhere else (it must be writable) |
| `LU_MINAL_LIBC=musl` / `glibc` | override the C library detection on Linux |
| `LU_MINAL_NO_DESKTOP=1` | no applications-menu entry |
| `LU_MINAL_BASE_URL=...` | download from a mirror (or a local folder) |
| `LU_MINAL_NO_VERIFY=1` | skip the checksum check (not recommended) |

```sh
curl -fsSL https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.sh | LU_MINAL_VERSION=0.2.0 sh
```

Running it again updates lu-minal (even while it is running). To uninstall, delete
`~/.local/bin/lu-minal` (and `~/.local/share/applications/lu-minal.desktop`).

## Windows setup

From 0.1.1 on, every release has a setup program: `lu-minal-windows-x64-setup.exe`, or
`lu-minal-windows-arm64-setup.exe` for Windows on Arm. It installs lu-minal for you alone,
without administrator rights, into `%LOCALAPPDATA%\Programs\lu-minal` (the folder install.ps1
uses, so either one updates the other). It asks what else to do:

- **Add lu-minal to my PATH**, so `lu-minal` works in any new terminal;
- **Add a lu-minal profile to Windows Terminal** (Moon Dark colours); the Start menu entry then
  opens lu-minal in Windows Terminal;
- **Create a desktop shortcut** (off unless you tick it).

Running a newer setup updates lu-minal in place (it closes a running lu-minal first, after
asking). Uninstall it in Settings > Apps > Installed apps: that removes the program, the PATH
entry, the shortcuts and the Windows Terminal profile, and keeps your settings, keys and sessions
(`%APPDATA%\lu-minal`, `%LOCALAPPDATA%\lu-minal`).

The setup programs are not code-signed yet, so Windows SmartScreen may say "Windows protected
your PC": click **More info**, then **Run anyway**. Check the download against `SHA256SUMS` first
if you like (`Get-FileHash lu-minal-windows-x64-setup.exe`).

For scripted installs:

```powershell
.\lu-minal-windows-x64-setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="path,terminal"
```

`/DIR="..."` installs somewhere else; `/LOG="setup.log"` writes a log. The uninstaller
(`unins000.exe` in the install folder) takes `/VERYSILENT` too.

## install.ps1 (Windows)

In PowerShell (Windows PowerShell 5.1 or PowerShell 7):

```powershell
irm https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.ps1 | iex
```

It picks `lu-minal-windows-x64.exe` or `-arm64.exe` (it reads the real CPU, also from an x64
PowerShell on Windows on Arm), checks it against `SHA256SUMS`, installs it to
`%LOCALAPPDATA%\Programs\lu-minal\lu-minal.exe` (no administrator rights needed), adds that
folder to your user PATH, and offers to add the lu-minal profile to Windows Terminal. Open a new
terminal afterwards so it sees the new PATH.

The same variables as for install.sh work (`LU_MINAL_VERSION`, `LU_MINAL_INSTALL_DIR`,
`LU_MINAL_BASE_URL`, `LU_MINAL_NO_VERIFY`), plus `LU_MINAL_ARCH=x64|arm64`,
`LU_MINAL_NO_PATH=1` and `LU_MINAL_WINDOWS_TERMINAL=1` (add the profile without asking) or `0`.

```powershell
$env:LU_MINAL_VERSION = '0.2.0'; irm https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.ps1 | iex
```

Running it again updates lu-minal. To uninstall, delete `%LOCALAPPDATA%\Programs\lu-minal`,
remove it from your user PATH (Settings > System > About > Advanced system settings >
Environment Variables) and run `lu-minal setup windows-terminal --remove` first if you added the
profile (or delete `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\lu-minal`).

## Windows Terminal profile

```powershell
lu-minal setup windows-terminal
```

adds a **lu-minal** profile to Windows Terminal's new-tab menu, with the **Moon Dark** colour
scheme (the Moon palette: the night-950 sky, lavender, mint, a moonlight-gold cursor) and
Cascadia Mono. It is a [JSON fragment](https://learn.microsoft.com/windows/terminal/json-fragment-extensions)
in `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\lu-minal\lu-minal.json`, so your own
`settings.json` is never touched; Windows Terminal picks it up the next time it starts. The
profile starts the lu-minal you ran the command with (the binary, or node with a source build).
You can also pick "Moon Dark" for any other profile in Windows Terminal's settings.

## The macOS app

`lu-minal-macos-app.zip` (or `.dmg`) from the [releases](https://github.com/Luna-OS/lu-minal/releases/latest)
contains **LuMinal.app**: a native window (Swift, AppKit, SwiftTerm) in the Moon look, with
lu-minal built in and true colour. Move it to `/Applications`.

- One window per session: **Cmd+N** new session, **Cmd+O** open a project folder, **Cmd+W**
  close, **Cmd+Q** quit, **Cmd+=** / **Cmd+-** / **Cmd+0** font size, Cmd+C / Cmd+V copy and paste.
- Drop a folder on the Dock icon (or on LuMinal.app in the Finder), or run
  `open -a LuMinal ~/code/app`, to start a session there.
- It starts lu-minal with your login shell's environment, so `claude`, Homebrew and nvm tools
  are found as in Terminal.
- View > Use Option as Meta Key sends Alt shortcuts (off by default, so Option keeps typing
  characters like `@` and `[` on international keyboards).

The app is signed ad-hoc, not with an Apple Developer ID, so on first start macOS says it "can't
be opened because Apple cannot check it": **right-click LuMinal.app > Open** and confirm (on
macOS 15+: System Settings > Privacy & Security > **Open Anyway**), or run
`xattr -dr com.apple.quarantine /Applications/LuMinal.app`. Building it yourself is described
in [macos/README.md](../macos/README.md).

## Linux applications menu

install.sh adds lu-minal to the applications menu on desktops (GNOME, KDE, Xfce, ...). For a
source build or a binary you placed yourself, run from a checkout or release:

```sh
linux/install-desktop.sh                     # uses the lu-minal on your PATH
linux/install-desktop.sh ~/bin/lu-minal      # or a given one
linux/install-desktop.sh --uninstall
```

It copies [linux/lu-minal.desktop](../linux/lu-minal.desktop) (`Terminal=true`, so it opens in
your default terminal emulator) to `~/.local/share/applications`, pointing `Exec` at the
absolute path, and the icon to `~/.local/share/icons/hicolor/scalable/apps/lu-minal.svg`.

## Terminals

lu-minal draws an animated night sky with 24-bit ("true") colour. It works in any terminal, but
looks right only in one with true colour:

- **Windows:** use [Windows Terminal](https://aka.ms/terminal) (built into Windows 11, in the
  Microsoft Store for Windows 10): true colour, proper key handling, Cascadia Mono. The classic
  console window (conhost, what `cmd.exe` opens on Windows 10) works but is slow and swallows key
  combinations. The VS Code terminal works well too.
- **macOS:** Terminal.app before macOS 26 shows only 256 colours, so the Moon palette is
  approximated. The lu-minal app, [iTerm2](https://iterm2.com), [Ghostty](https://ghostty.org),
  [WezTerm](https://wezfurlong.org/wezterm/), Kitty, Alacritty and the VS Code terminal show true
  colour. In iTerm2 and Terminal.app, set Option to act as Meta (Esc+) if you want Alt shortcuts.
- **Linux:** any terminal with true colour - GNOME Terminal / Console, Konsole, Ptyxis, Ghostty,
  WezTerm, Kitty, Alacritty, foot, xterm with `COLORTERM=truecolor`. Inside tmux, add
  `set -as terminal-features ",*:RGB"` to `~/.tmux.conf`.

lu-minal detects true colour through `COLORTERM=truecolor` (most modern terminals set it). If
colours look washed out in a terminal that does support true colour, `export COLORTERM=truecolor`.
Every keyboard shortcut also has a slash command (`/help`), for terminals that keep some keys
for themselves.

## Where lu-minal keeps its files

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Settings, keys, themes | `%APPDATA%\lu-minal` | `~/.config/lu-minal` | `$XDG_CONFIG_HOME/lu-minal` (`~/.config/lu-minal`) |
| Cache | `%LOCALAPPDATA%\lu-minal\cache` | `~/Library/Caches/lu-minal` | `$XDG_CACHE_HOME/lu-minal` |
| Session | `%LOCALAPPDATA%\lu-minal\state` | `~/Library/Application Support/lu-minal` | `$XDG_STATE_HOME/lu-minal` |

Set `LU_MINAL_HOME` to keep all of them in one folder (portable installs).

## Building the binaries yourself

```sh
npm ci
bun scripts/build-binaries.ts                    # every platform into dist-bin/, plus SHA256SUMS
bun scripts/build-binaries.ts --target=host      # just this machine
bun scripts/build-binaries.ts --target=host,windows-x64 --smoke   # --smoke runs this machine's binary
bun scripts/build-binaries.ts --list             # the targets
```

Bun cross-compiles every target from any machine. Windows version information is embedded only
when the Windows binaries are built on Windows, and the macOS binaries are signed (ad-hoc, with
`codesign`) only when they are built on a Mac. Built elsewhere, the arm64 one still has a valid
signature from Bun, but the x64 one does not, so sign it on a Mac
(`codesign --force --sign - lu-minal-macos-x64`) before macOS runs it. The release workflow builds
each on its own system. Releases are built by `.github/workflows/release.yml` when a `v*` tag is
pushed, or when the workflow is started by hand (Actions tab, "Run workflow") with the version from
`package.json`; it then creates the tag on the commit it built.
