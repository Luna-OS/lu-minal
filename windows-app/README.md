# lu-minal window for Windows

`lu-minal-window.exe` is lu-minal's own window on Windows. It has the terminal on the left, with
lu-minal running in it, and the **Claude Code website** ([claude.ai/code](https://claude.ai/code),
your cloud sessions) in a pane on the right. The Windows setup installs it next to `lu-minal.exe`,
and the Start menu entry **lu-minal**, the desktop shortcut and "Start lu-minal" open it. You can
still open lu-minal in Windows Terminal from the second Start menu entry, **lu-minal in Windows
Terminal**. The window app ships only inside the setup, not as a release file of its own.

The pane shows the real website, the same page as in your browser. lu-minal only displays it and
decides where it may navigate. It never scripts the page, never reads what is on it, and never
touches its cookies or storage.

## Keys

| | |
| --- | --- |
| **Ctrl+Shift+K** | show or hide the cloud pane (also the rail at the right edge, and × in the pane's header) |
| **Ctrl+C** | copy the selection, or send Ctrl+C to lu-minal when nothing is selected |
| **Ctrl+Shift+C**, **Ctrl+Insert** | copy the selection |
| **Ctrl+V**, **Ctrl+Shift+V**, **Shift+Insert** | paste. With a picture or files on the clipboard (copied in Explorer), lu-minal attaches them |
| right click | copy the selection, or paste |
| **Shift**+drag | select text while lu-minal uses the mouse (wheel scrolling) |
| **Ctrl+=** / **Ctrl+-** / **Ctrl+0** | bigger / smaller / default font size in the terminal (in the pane they zoom the page) |
| **Ctrl**+click | open a link printed in the terminal: claude.ai links in the pane, others in your browser |

Drag the divider between the terminal and the pane to change the pane's width. The pane's header
has back, reload, **open in browser** (the current page in your default browser) and close.

lu-minal can also open the pane itself, for example on a cloud session. It writes a private
escape sequence (`ESC ] 7701 ; open ; <url> BEL`, or `show`, `hide`, `toggle`). The window takes
it out of the output, and it accepts only `https://claude.ai/...` URLs. lu-minal knows it runs
here because the window sets `LU_MINAL_WEB_PANE=1` and `TERM_PROGRAM=lu-minal-window`.

## Signing in

Sign in to claude.ai once, inside the pane, with **Continue with email**: Claude sends you a code
by email, and you type it in the pane. Google sign-in doesn't work here, because Google refuses
to sign in inside embedded web views. The pane says so when a link leads there. You stay signed
in between runs.

The pane loads pages on claude.ai, anthropic.com and Cloudflare's check (claude.ai sits behind
it). Every other link opens in your default browser.

## Where things are kept

| | |
| --- | --- |
| The window's size and place, the pane's width and whether it is open, the font size | `%LOCALAPPDATA%\lu-minal\window.json` |
| The pane's browser data (your sign-in to claude.ai) | `%LOCALAPPDATA%\lu-minal\WebView2` |
| lu-minal's own settings and sessions | as everywhere: `%APPDATA%\lu-minal`, `%LOCALAPPDATA%\lu-minal` |

Uninstalling lu-minal leaves these folders in place. To sign out of the pane, sign out on
claude.ai, or delete the `WebView2` folder while the window is closed.

The window needs the Microsoft Edge **WebView2 Runtime**. It comes with Windows 11 and current
Windows 10. When it is missing, the window offers the
[download](https://go.microsoft.com/fwlink/p/?LinkId=2124703), or lu-minal in a console window
instead.

Closing the window while lu-minal runs asks first. lu-minal then gets the console's close signal
and has 5 seconds to end before it is stopped. Your tabs come back the next time you start it.
When lu-minal ends by itself, the window shows `[lu-minal ended] Press any key to close`.

## How it works

- **Rust**: [tao](https://crates.io/crates/tao) for the window and
  [wry](https://crates.io/crates/wry) for the two WebView2 views in it. lu-minal runs in a ConPTY
  ([portable-pty](https://crates.io/crates/portable-pty)). The crate versions are pinned in
  `Cargo.toml`, and `Cargo.lock` is committed.
- **The terminal** is [xterm.js](https://xtermjs.org) 6 with the fit, unicode11 and WebGL
  addons. It falls back to the DOM renderer when WebGL is not available. It draws the Moon
  palette in Cascadia Mono. Its page (`web/`) is served from a custom protocol under a strict
  Content Security Policy (no network) and is the only one with an IPC channel to the host. It
  also draws the pane's header and the divider. The pane's web view lies over the space the page
  leaves for it.
- **Output**: a reader thread takes lu-minal's output, the OSC 7701 filter (`src/osc.rs`) takes
  the pane commands out, and batches go to xterm.js about every 8 ms. While xterm.js falls
  behind, lu-minal waits.
- **The pane** (`src/urls.rs`) has no IPC, no scripts of ours and the default user agent. Its
  navigation is checked on the parsed URL.

Pure logic (the OSC filter, URL rules, settings, layout, the page protocol) is in modules without
Windows code. `cargo test` runs them on any OS.

## Building

On Windows, with Node 22+ and Rust (stable, MSVC):

```powershell
npm ci
node scripts/windows-app-assets.mjs     # xterm.js and the icon into windows-app/assets (gitignored)
cargo build --manifest-path windows-app/Cargo.toml --release
```

The exe is `windows-app\target\release\lu-minal-window.exe`. Put a `lu-minal.exe` next to it
(`bun scripts/build-binaries.ts --target=windows-x64`, renamed), or point the window at one with
`--program=<path>`. The version comes from the repository's `package.json`. The icon, version
info and manifest are only embedded when building on Windows (they need `rc.exe` from the Windows
SDK).

On another OS, `cargo test --manifest-path windows-app/Cargo.toml` runs the unit tests, and
`cargo check --target x86_64-pc-windows-msvc` checks the Windows code (after the assets script).

Command line: `lu-minal-window.exe [folder] [--program=<lu-minal.exe>]`. lu-minal starts in the
folder (default: your user folder). For CI, `--smoke[=<file>]` opens the window and both web
views, runs `lu-minal.exe --version`, and writes `smoke ok <version>` once xterm.js has shown the
version. `--smoke-osc[=<file>]` checks that OSC 7701 sequences printed in the terminal (by
`node`) reach the window and are taken out.
