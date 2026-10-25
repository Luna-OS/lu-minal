#!/bin/sh
# Adds lu-minal to the Linux applications menu (GNOME, KDE, Xfce, ...): copies lu-minal.desktop to
# ~/.local/share/applications and the icon to ~/.local/share/icons/hicolor/scalable/apps. The entry
# runs lu-minal in your default terminal (Terminal=true). install.sh does this for you already.
#
#   linux/install-desktop.sh              use the lu-minal found on the PATH
#   linux/install-desktop.sh /path/to/lu-minal
#   linux/install-desktop.sh --uninstall
set -eu

here=$(cd "$(dirname "$0")" && pwd)
data="${XDG_DATA_HOME:-$HOME/.local/share}"
apps="$data/applications"
icons="$data/icons/hicolor/scalable/apps"

refresh() {
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$apps" >/dev/null 2>&1 || true; fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t "$data/icons/hicolor" >/dev/null 2>&1 || true; fi
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$apps/lu-minal.desktop" "$icons/lu-minal.svg"
  refresh
  echo "Removed lu-minal from the applications menu."
  exit 0
fi

exe="${1:-}"
if [ -z "$exe" ]; then
  exe=$(command -v lu-minal 2>/dev/null || true)
  if [ -z "$exe" ] && [ -x "$HOME/.local/bin/lu-minal" ]; then exe="$HOME/.local/bin/lu-minal"; fi
fi
if [ -z "$exe" ]; then
  echo "lu-minal is not on your PATH. Install it first (install.sh, or from source: https://github.com/Luna-OS/lu-minal#from-source), or pass its path." >&2
  exit 1
fi
case "$exe" in
  /*) ;;
  *) exe="$(pwd)/$exe" ;;
esac
[ -x "$exe" ] || {
  echo "Not an executable: $exe" >&2
  exit 1
}

# The desktop session may not have ~/.local/bin on its PATH: point the entry at the program itself.
escape() { printf '%s' "$1" | sed 's/[\\|&]/\\&/g'; }
case "$exe" in
  *" "*) exec_line="\"$exe\"" ;;
  *) exec_line=$exe ;;
esac

mkdir -p "$apps" "$icons"
cp "$here/lu-minal.svg" "$icons/lu-minal.svg"
sed "s|^Exec=lu-minal|Exec=$(escape "$exec_line")|; s|^TryExec=lu-minal|TryExec=$(escape "$exe")|" \
  "$here/lu-minal.desktop" >"$apps/lu-minal.desktop"
chmod 644 "$apps/lu-minal.desktop"
refresh
echo "Added lu-minal to the applications menu ($apps/lu-minal.desktop, runs $exe)."
