#!/usr/bin/env bash
# Builds LuMinal.app: the Swift app (universal arm64 + x86_64 when the toolchain can), the
# lu-minal binary inside it (Contents/Resources/bin/lu-minal), Info.plist, the app icon, an ad-hoc
# signature, and a zip (ditto) - optionally a .dmg too. Runs on macOS with Xcode or the Swift
# toolchain (bash 3.2 compatible).
#
#   macos/scripts/bundle-app.sh --binary dist-bin/lu-minal-macos-arm64 --binary dist-bin/lu-minal-macos-x64
#
# Options:
#   --binary <file>    the Bun-compiled lu-minal to bundle; give it twice (arm64 + x64) for a
#                      universal binary (lipo). Without it the app runs lu-minal from the PATH.
#   --out <dir>        where LuMinal.app and the archives go (default: macos/build)
#   --version <v>      CFBundleShortVersionString (default: package.json's version)
#   --arch <a>         universal (default), arm64, x86_64 or native
#   --dmg              also make lu-minal-macos-app.dmg
#   --no-zip           don't make lu-minal-macos-app.zip
#   --icon <png>       a 1024 x 1024 PNG to use instead of drawing the icon
# Environment:
#   LU_MINAL_SIGN_IDENTITY  a "Developer ID Application: ..." identity; default "-" (ad-hoc)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MACOS="$ROOT/macos"
OUT="$MACOS/build"
VERSION=""
ARCH="universal"
DMG=0
ZIP=1
ICON_PNG=""
BINARY_1=""
BINARY_2=""
IDENTITY="${LU_MINAL_SIGN_IDENTITY:--}"

say() { printf '%s\n' "$*" >&2; }
step() { say "==> $*"; }
warn() { say "warning: $*"; }
die() {
  say "error: $*"
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --binary)
      [ $# -ge 2 ] || die "--binary needs a file"
      if [ -z "$BINARY_1" ]; then BINARY_1=$2; elif [ -z "$BINARY_2" ]; then BINARY_2=$2; else die "at most two --binary files"; fi
      shift 2
      ;;
    --out) OUT=$2; shift 2 ;;
    --version) VERSION=${2#v}; shift 2 ;;
    --arch) ARCH=$2; shift 2 ;;
    --dmg) DMG=1; shift ;;
    --no-zip) ZIP=0; shift ;;
    --icon) ICON_PNG=$2; shift 2 ;;
    -h | --help)
      sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option $1 (try --help)" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || die "LuMinal.app can only be built on macOS."
command -v swift >/dev/null 2>&1 || die "swift not found: install Xcode or the Command Line Tools (xcode-select --install)."
case "$ARCH" in universal | arm64 | x86_64 | native) ;; *) die "--arch must be universal, arm64, x86_64 or native" ;; esac

if [ -z "$VERSION" ]; then
  VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
fi
[ -n "$VERSION" ] || die "no version (pass --version)"
BUILD=${VERSION%%[-+]*}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)

# ---- the Swift app -------------------------------------------------------------------------------

swift_build() {
  swift build -c release --package-path "$MACOS" "$@"
}

step "Building the Swift app ($ARCH)"
BIN_DIR=""
case "$ARCH" in
  universal)
    if swift_build --arch arm64 --arch x86_64; then
      BIN_DIR=$(swift_build --arch arm64 --arch x86_64 --show-bin-path)
    else
      warn "the universal build failed; building for this Mac's architecture only"
      swift_build
      BIN_DIR=$(swift_build --show-bin-path)
    fi
    ;;
  arm64 | x86_64)
    swift_build --arch "$ARCH"
    BIN_DIR=$(swift_build --arch "$ARCH" --show-bin-path)
    ;;
  native)
    swift_build
    BIN_DIR=$(swift_build --show-bin-path)
    ;;
esac
[ -x "$BIN_DIR/LuMinal" ] || die "the build produced no $BIN_DIR/LuMinal"

# ---- LuMinal.app ---------------------------------------------------------------------------------

APP="$OUT/LuMinal.app"
step "Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/LuMinal" "$APP/Contents/MacOS/LuMinal"
# SwiftPM resource bundles of dependencies, if any (SwiftTerm looks in Contents/Resources).
for bundle in "$BIN_DIR"/*.bundle; do
  if [ -d "$bundle" ]; then cp -R "$bundle" "$APP/Contents/Resources/"; fi
done
sed -e "s/@VERSION@/$VERSION/g" -e "s/@BUILD@/$BUILD/g" "$MACOS/Resources/Info.plist" >"$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' >"$APP/Contents/PkgInfo"

LU_MINAL="$APP/Contents/Resources/bin/lu-minal"
if [ -n "$BINARY_1" ]; then
  [ -f "$BINARY_1" ] || die "no such binary: $BINARY_1"
  mkdir -p "$APP/Contents/Resources/bin"
  if [ -n "$BINARY_2" ]; then
    [ -f "$BINARY_2" ] || die "no such binary: $BINARY_2"
    step "Combining $(basename "$BINARY_1") and $(basename "$BINARY_2") into a universal lu-minal"
    lipo -create "$BINARY_1" "$BINARY_2" -output "$LU_MINAL"
  else
    cp "$BINARY_1" "$LU_MINAL"
  fi
  chmod 755 "$LU_MINAL"
  APP_ARCHS=$(lipo -archs "$APP/Contents/MacOS/LuMinal")
  BIN_ARCHS=$(lipo -archs "$LU_MINAL")
  for a in $APP_ARCHS; do
    case " $BIN_ARCHS " in
      *" $a "*) ;;
      *) warn "the app runs on $a but the bundled lu-minal is only $BIN_ARCHS" ;;
    esac
  done
else
  warn "no --binary: the app will run lu-minal from the PATH"
fi

# ---- the icon ------------------------------------------------------------------------------------

make_icon() {
  local work png iconset size
  work=$(mktemp -d)
  png="$work/icon.png"
  if [ -n "$ICON_PNG" ]; then
    cp "$ICON_PNG" "$png" || return 1
  else
    xcrun swift "$MACOS/scripts/make-icon.swift" "$png" || return 1
  fi
  iconset="$work/AppIcon.iconset"
  mkdir "$iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$png" --out "$iconset/icon_${size}x${size}.png" >/dev/null || return 1
    sips -z $((size * 2)) $((size * 2)) "$png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null || return 1
  done
  iconutil -c icns "$iconset" -o "$1" || return 1
  rm -rf "$work"
}

step "Drawing the app icon"
if ! make_icon "$APP/Contents/Resources/AppIcon.icns"; then
  warn "could not make AppIcon.icns; the app gets the generic icon"
  rm -f "$APP/Contents/Resources/AppIcon.icns"
fi

# ---- signing -------------------------------------------------------------------------------------

# codesign refuses bundles with extended attributes ("resource fork, Finder information, or similar
# detritus not allowed").
xattr -cr "$APP"
if [ "$IDENTITY" = "-" ]; then
  step "Signing (ad-hoc)"
  if [ -f "$LU_MINAL" ]; then codesign --force --sign - "$LU_MINAL"; fi
  codesign --force --deep --sign - "$APP"
else
  step "Signing as $IDENTITY (hardened runtime)"
  if [ -f "$LU_MINAL" ]; then
    codesign --force --timestamp --options runtime \
      --entitlements "$MACOS/entitlements/lu-minal-binary.entitlements" --sign "$IDENTITY" "$LU_MINAL"
  fi
  codesign --force --timestamp --options runtime --sign "$IDENTITY" "$APP"
fi
codesign --verify --deep --verbose=2 "$APP"

# ---- checks that need no window ------------------------------------------------------------------

step "Checking the app"
ENV_OUT=$("$APP/Contents/MacOS/LuMinal" --lu-minal-print-env) || die "LuMinal did not start"
case "$ENV_OUT" in
  *LU-MINAL-ENV-END*) ;;
  *) die "LuMinal did not print its environment (--lu-minal-print-env)" ;;
esac
if [ -f "$LU_MINAL" ]; then
  BUNDLED_VERSION=$("$LU_MINAL" --version) || die "the bundled lu-minal did not start"
  say "    bundled lu-minal $BUNDLED_VERSION ($(lipo -archs "$LU_MINAL"))"
fi
say "    LuMinal $(lipo -archs "$APP/Contents/MacOS/LuMinal")"

# ---- archives ------------------------------------------------------------------------------------

if [ "$ZIP" = 1 ]; then
  ZIP_FILE="$OUT/lu-minal-macos-app.zip"
  step "Zipping $ZIP_FILE"
  rm -f "$ZIP_FILE"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP_FILE"
fi

if [ "$DMG" = 1 ]; then
  DMG_FILE="$OUT/lu-minal-macos-app.dmg"
  step "Making $DMG_FILE"
  STAGE=$(mktemp -d)
  ditto "$APP" "$STAGE/LuMinal.app"
  ln -s /Applications "$STAGE/Applications"
  rm -f "$DMG_FILE"
  made=0
  for attempt in 1 2 3; do
    if hdiutil create -volname "lu-minal" -srcfolder "$STAGE" -ov -format UDZO "$DMG_FILE" >/dev/null; then
      made=1
      break
    fi
    warn "hdiutil failed (attempt $attempt), retrying"
    sleep 3
  done
  rm -rf "$STAGE"
  [ "$made" = 1 ] || die "hdiutil could not make the disk image"
fi

step "Done: $APP"
