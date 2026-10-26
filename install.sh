#!/bin/sh
# lu-minal installer for macOS and Linux: downloads the standalone binary for this machine from
# the GitHub releases, checks it against the release's SHA256SUMS and puts it on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.sh | sh
#
# Settings (environment variables):
#   LU_MINAL_VERSION      a release to install ("0.2.0" or "v0.2.0"); default: the latest
#   LU_MINAL_INSTALL_DIR  where the binary goes; default: ~/.local/bin
#   LU_MINAL_LIBC         Linux only: "musl" or "glibc" instead of detecting it
#   LU_MINAL_BASE_URL     download from this URL (or folder) instead of GitHub (mirrors, tests)
#   LU_MINAL_NO_VERIFY=1  skip the checksum check (not recommended)
#   LU_MINAL_NO_DESKTOP=1 Linux only: don't add the lu-minal entry to the applications menu
#
# On Windows, use install.ps1:  irm https://raw.githubusercontent.com/Luna-OS/lu-minal/main/install.ps1 | iex
set -eu

REPO="Luna-OS/lu-minal"

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  C_ACCENT=$(printf '\033[38;2;185;174;251m')
  C_OK=$(printf '\033[38;2;127;227;198m')
  C_WARN=$(printf '\033[38;2;243;199;102m')
  C_ERR=$(printf '\033[38;2;242;139;146m')
  C_DIM=$(printf '\033[2m')
  C_OFF=$(printf '\033[0m')
else
  C_ACCENT='' C_OK='' C_WARN='' C_ERR='' C_DIM='' C_OFF=''
fi

say() { printf '%s\n' "$*" >&2; }
info() { say "${C_ACCENT}*${C_OFF} $*"; }
ok() { say "${C_OK}*${C_OFF} $*"; }
warn() { say "${C_WARN}! $*${C_OFF}"; }
die() {
  say "${C_ERR}x $*${C_OFF}"
  exit 1
}

has() { command -v "$1" >/dev/null 2>&1; }

# Escapes text for the replacement side of a sed "s|...|...|" command.
sed_escape() { printf '%s' "$1" | sed 's/[\\|&]/\\&/g'; }

# ---- what to download ------------------------------------------------------------------------

detect_os() {
  case "$(uname -s)" in
    Linux) echo linux ;;
    Darwin) echo macos ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      die "This is Windows: run install.ps1 in PowerShell instead:
    irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
    *) die "There is no lu-minal binary for $(uname -s). Build it from source instead (Node 22+): https://github.com/$REPO#from-source" ;;
  esac
}

detect_arch() {
  arch=$(uname -m)
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64 | armv8* | arm64e) arch=arm64 ;;
    *) die "There is no lu-minal binary for the $arch CPU. Build it from source instead (Node 22+): https://github.com/$REPO#from-source" ;;
  esac
  if [ "$1" = macos ] && [ "$arch" = x64 ]; then
    # An x64 shell under Rosetta on Apple silicon still gets the native binary.
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
  fi
  if [ "$1" = linux ] && [ "$arch" = arm64 ] && has getconf && [ "$(getconf LONG_BIT 2>/dev/null || echo 64)" = 32 ]; then
    die "This is a 32-bit system on a 64-bit CPU; lu-minal needs a 64-bit system. Build it from source instead (Node 22+): https://github.com/$REPO#from-source"
  fi
  echo "$arch"
}

is_musl() {
  case "${LU_MINAL_LIBC:-}" in
    musl) return 0 ;;
    glibc | gnu) return 1 ;;
    *) ;;
  esac
  # glibc answers GNU_LIBC_VERSION; musl's getconf does not know it. (Checked first: Debian's and
  # Ubuntu's "musl" package puts /lib/ld-musl-*.so.1 on glibc systems too.)
  if has getconf && getconf GNU_LIBC_VERSION >/dev/null 2>&1; then return 1; fi
  if has ldd && ldd --version 2>&1 | grep -qi musl; then return 0; fi
  for f in /lib/ld-musl-*.so.1; do
    [ -e "$f" ] && return 0
  done
  return 1
}

base_url() {
  if [ -n "${LU_MINAL_BASE_URL:-}" ]; then
    printf '%s' "${LU_MINAL_BASE_URL%/}"
    return
  fi
  version="${LU_MINAL_VERSION:-latest}"
  if [ "$version" = latest ]; then
    printf 'https://github.com/%s/releases/latest/download' "$REPO"
  else
    case "$version" in v*) ;; *) version="v$version" ;; esac
    printf 'https://github.com/%s/releases/download/%s' "$REPO" "$version"
  fi
}

# ---- downloading and checking ----------------------------------------------------------------

# download <url or folder path> <file> [quiet]
download() {
  src=$1
  dest=$2
  case "$src" in
    http://* | https://* | file://*) ;;
    *)
      # A local folder (LU_MINAL_BASE_URL=/path/to/dist-bin).
      cp "$src" "$dest" 2>/dev/null
      return
      ;;
  esac
  if has curl; then
    if [ -z "${3:-}" ] && [ -t 2 ]; then
      curl -fL --retry 3 --proto-redir =https --progress-bar -o "$dest" "$src"
    else
      curl -fsSL --retry 3 --proto-redir =https -o "$dest" "$src"
    fi
  elif has wget; then
    wget -q -O "$dest" "$src"
  else
    die "Neither curl nor wget is installed - install one of them and run this again."
  fi
}

sha256_of() {
  if has sha256sum; then
    sha256sum "$1" | awk '{ print $1 }'
  elif has shasum; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif has openssl; then
    openssl dgst -sha256 -r "$1" | awk '{ print $1 }'
  else
    return 1
  fi
}

# expected_sha256 <SHA256SUMS file> <asset name>
expected_sha256() {
  awk -v f="$2" '{ n = $2; sub(/\r$/, "", n); sub(/^\*/, "", n); if (n == f) { print tolower($1); exit } }' "$1"
}

verify() {
  file=$1
  asset=$2
  sums=$3
  if [ "${LU_MINAL_NO_VERIFY:-}" = 1 ]; then
    warn "Skipping the checksum check (LU_MINAL_NO_VERIFY=1)."
    return
  fi
  if ! download "$BASE/SHA256SUMS" "$sums" quiet; then
    die "Could not download SHA256SUMS from $BASE to check the download.
  (Set LU_MINAL_NO_VERIFY=1 to install without checking - not recommended.)"
  fi
  want=$(expected_sha256 "$sums" "$asset")
  [ -n "$want" ] || die "SHA256SUMS has no entry for $asset."
  if ! got=$(sha256_of "$file"); then
    warn "No sha256sum, shasum or openssl found: cannot check the download."
    return
  fi
  if [ "$got" != "$want" ]; then
    die "Checksum mismatch for $asset:
    expected $want
    got      $got
  The download is broken or was tampered with; nothing was installed."
  fi
  ok "Checksum OK ${C_DIM}($want)${C_OFF}"
}

# ---- the Linux applications menu ---------------------------------------------------------------

install_desktop_entry() {
  exe=$1
  [ "${LU_MINAL_NO_DESKTOP:-}" = 1 ] && return
  # Only on desktops; servers and containers don't need a menu entry.
  [ -n "${XDG_CURRENT_DESKTOP:-}${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || return 0
  data="${XDG_DATA_HOME:-$HOME/.local/share}"
  apps="$data/applications"
  icons="$data/icons/hicolor/scalable/apps"
  mkdir -p "$apps" "$icons" || return 0
  write_icon >"$icons/lu-minal.svg"
  # Exec is a command line (quote a path with spaces); TryExec is a plain path.
  case "$exe" in
    *" "*) exec_line="\"$exe\"" ;;
    *) exec_line=$exe ;;
  esac
  write_desktop_entry |
    sed "s|^Exec=lu-minal|Exec=$(sed_escape "$exec_line")|; s|^TryExec=lu-minal|TryExec=$(sed_escape "$exe")|" \
      >"$apps/lu-minal.desktop"
  chmod 644 "$apps/lu-minal.desktop"
  if has update-desktop-database; then update-desktop-database "$apps" >/dev/null 2>&1 || true; fi
  if has gtk-update-icon-cache; then gtk-update-icon-cache -q -t "$data/icons/hicolor" >/dev/null 2>&1 || true; fi
  ok "Added lu-minal to the applications menu ${C_DIM}($apps/lu-minal.desktop)${C_OFF}"
}

# Kept identical to linux/lu-minal.desktop (test/platform/distribution.test.ts checks it).
write_desktop_entry() {
  cat <<'DESKTOP'
[Desktop Entry]
Type=Application
Version=1.5
Name=lu-minal
GenericName=Coding Agents Terminal
Comment=A team of coding agents under the night sky
Exec=lu-minal
TryExec=lu-minal
Icon=lu-minal
Terminal=true
Categories=Development;IDE;
Keywords=terminal;agents;ai;claude;coding;tui;
StartupNotify=false
DESKTOP
}

# Kept identical to linux/lu-minal.svg (test/platform/distribution.test.ts checks it).
write_icon() {
  cat <<'ICON'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="sky" gradientUnits="userSpaceOnUse" x1="8" y1="8" x2="248" y2="248">
      <stop offset="0" stop-color="#3a2a80"/>
      <stop offset=".45" stop-color="#1d1742"/>
      <stop offset="1" stop-color="#0b0920"/>
    </linearGradient>
    <linearGradient id="rim" gradientUnits="userSpaceOnUse" x1="0" y1="8" x2="0" y2="120">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".2"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="132" cy="112" r="124">
      <stop offset="0" stop-color="#b9aefb" stop-opacity=".34"/>
      <stop offset=".25" stop-color="#b9aefb" stop-opacity=".2"/>
      <stop offset=".5" stop-color="#b9aefb" stop-opacity=".09"/>
      <stop offset=".75" stop-color="#b9aefb" stop-opacity=".025"/>
      <stop offset="1" stop-color="#b9aefb" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="moonlight" gradientUnits="userSpaceOnUse" x1="104" y1="142" x2="188" y2="58">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset=".55" stop-color="#f4f1ff"/>
      <stop offset="1" stop-color="#d6cffd"/>
    </linearGradient>
    <radialGradient id="sparkle-glow" gradientUnits="userSpaceOnUse" cx="196" cy="64" r="34">
      <stop offset="0" stop-color="#e0c880" stop-opacity=".45"/>
      <stop offset=".4" stop-color="#e0c880" stop-opacity=".14"/>
      <stop offset="1" stop-color="#e0c880" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="sparkle" gradientUnits="userSpaceOnUse" cx="196" cy="64" r="24">
      <stop offset="0" stop-color="#fffbef"/>
      <stop offset=".3" stop-color="#f7e2a6"/>
      <stop offset="1" stop-color="#e0c880"/>
    </radialGradient>
    <filter id="halo" filterUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
    <filter id="phosphor" filterUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
      <feGaussianBlur stdDeviation="5"/>
    </filter>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#sky)"/>
  <rect x="9" y="9" width="238" height="238" rx="55" fill="none" stroke="url(#rim)" stroke-width="2"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#glow)"/>
  <circle cx="54" cy="62" r="5" fill="#b9aefb"/>
  <circle cx="100" cy="30" r="3" fill="#d6cffd"/>
  <circle cx="222" cy="150" r="4" fill="#d6cffd"/>
  <circle cx="208" cy="210" r="3" fill="#b9aefb"/>
  <path d="M137.62 32.52A68 68 0 1 0 209.99 122.99A58 58 0 0 1 137.62 32.52Z" fill="#d6cffd" opacity=".55" filter="url(#halo)"/>
  <path d="M137.62 32.52A68 68 0 1 0 209.99 122.99A58 58 0 0 1 137.62 32.52Z" fill="url(#moonlight)"/>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#sparkle-glow)"/>
  <path d="M196 40Q200 60 220 64Q200 68 196 88Q192 68 172 64Q192 60 196 40Z" fill="url(#sparkle)"/>
  <g fill="none" stroke="#7fe3c6" stroke-width="17" stroke-linecap="round" stroke-linejoin="round">
    <path d="M60 166L88 188L60 210" opacity=".4" filter="url(#phosphor)"/>
    <path d="M60 166L88 188L60 210"/>
  </g>
  <rect x="104" y="201" width="52" height="17" rx="8.5" fill="#7fe3c6" opacity=".4" filter="url(#phosphor)"/>
  <rect x="104" y="201" width="52" height="17" rx="8.5" fill="#7fe3c6"/>
</svg>
ICON
}

# ---- PATH --------------------------------------------------------------------------------------

path_hint() {
  dir=$1
  case ":${PATH}:" in
    *":$dir:"*) return ;;
  esac
  shell_name=$(basename "${SHELL:-sh}")
  say ""
  warn "$dir is not on your PATH yet. Add it, then open a new terminal:"
  case "$shell_name" in
    zsh) say "    echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zshrc" ;;
    bash)
      # The ~ is printed for the user to type, not expanded here.
      # shellcheck disable=SC2088
      if [ "$(uname -s)" = Darwin ]; then rc="~/.bash_profile"; else rc="~/.bashrc"; fi
      say "    echo 'export PATH=\"$dir:\$PATH\"' >> $rc"
      ;;
    fish) say "    fish_add_path $dir" ;;
    *) say "    export PATH=\"$dir:\$PATH\"   (in your shell's startup file)" ;;
  esac
}

# ---- main ------------------------------------------------------------------------------------

main() {
  os=$(detect_os)
  arch=$(detect_arch "$os")
  libc=""
  if [ "$os" = linux ] && is_musl; then libc="-musl"; fi
  asset="lu-minal-$os-$arch$libc"
  BASE=$(base_url)
  dir="${LU_MINAL_INSTALL_DIR:-$HOME/.local/bin}"

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t lu-minal)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  info "Downloading ${C_ACCENT}$asset${C_OFF} ${C_DIM}from $BASE${C_OFF}"
  download "$BASE/$asset" "$tmp/$asset" || die "Download failed: $BASE/$asset"
  [ -s "$tmp/$asset" ] || die "The download is empty: $BASE/$asset"
  verify "$tmp/$asset" "$asset" "$tmp/SHA256SUMS"

  mkdir -p "$dir" || die "Cannot create $dir (set LU_MINAL_INSTALL_DIR to install somewhere else)."
  # Copy next to the target and rename: atomic, and works while an old lu-minal is running.
  cp "$tmp/$asset" "$dir/.lu-minal.$$" || die "Cannot write to $dir (set LU_MINAL_INSTALL_DIR to install somewhere else)."
  chmod 755 "$dir/.lu-minal.$$"
  mv -f "$dir/.lu-minal.$$" "$dir/lu-minal"
  if [ "$os" = macos ]; then
    xattr -d com.apple.quarantine "$dir/lu-minal" >/dev/null 2>&1 || true
  fi

  if version=$("$dir/lu-minal" --version 2>/dev/null); then
    ok "Installed lu-minal ${C_ACCENT}$version${C_OFF} to $dir/lu-minal"
  else
    ok "Installed lu-minal to $dir/lu-minal"
    if [ -n "$libc" ]; then
      warn "It did not start. The musl build needs the C++ runtime: apk add libstdc++ (Alpine)"
    else
      warn "It did not start (\`$dir/lu-minal --version\` failed). On very old systems, build it from source instead (Node 22+): https://github.com/$REPO#from-source"
    fi
  fi

  if [ "$os" = linux ]; then install_desktop_entry "$dir/lu-minal"; fi
  path_hint "$dir"
  say ""
  say "  Run ${C_ACCENT}lu-minal${C_OFF} in a project folder to start. ${C_DIM}Docs: https://github.com/$REPO/blob/main/docs/install.md${C_OFF}"
  if [ "$os" = macos ]; then
    say "  ${C_DIM}Terminal.app before macOS 26 shows 256 colours only; the lu-minal app, iTerm2, Ghostty or WezTerm show true colour.${C_OFF}"
  fi
}

main "$@"
