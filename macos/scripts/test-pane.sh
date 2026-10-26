#!/usr/bin/env bash
# Compiles and runs macos/Tests/PaneTests: the cloud pane's OSC 7701 filter and its URL policy.
# Those two files are plain Swift and Foundation, so this runs on macOS and on Linux (with the
# Swift toolchain for Linux) and needs no Xcode project, AppKit or SwiftTerm. Bash 3.2 compatible.
#
#   bash macos/scripts/test-pane.sh            # swiftc from the PATH
#   SWIFTC=/path/to/swiftc bash macos/scripts/test-pane.sh
set -euo pipefail

MACOS=$(cd "$(dirname "$0")/.." && pwd)
SWIFTC=${SWIFTC:-swiftc}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

"$SWIFTC" -swift-version 5 -module-name PaneTests -o "$WORK/pane-tests" \
  "$MACOS/Sources/LuMinal/PaneSequenceFilter.swift" \
  "$MACOS/Sources/LuMinal/CloudPanePolicy.swift" \
  "$MACOS/Tests/PaneTests/main.swift"
"$WORK/pane-tests"
