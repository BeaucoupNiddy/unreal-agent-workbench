#!/bin/bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "$0")" && pwd)"
readonly app_dir="${1:-$HOME/Applications/Unreal Agent.app}"
readonly contents_dir="$app_dir/Contents"
readonly executable_dir="$contents_dir/MacOS"
readonly executable_path="$executable_dir/UnrealAgentCalendar"

/bin/mkdir -p "$executable_dir"
/bin/mkdir -p "$contents_dir/Resources"
/bin/cp "$script_dir/../scripts/Launch Unreal Agent.command" "$contents_dir/Resources/Launch Unreal Agent.command"
/bin/cp "$script_dir/calendar-helper/Info.plist" "$contents_dir/Info.plist"
/usr/bin/xcrun swiftc \
  -O \
  -framework AppKit \
  -framework EventKit \
  "$script_dir/calendar-helper/CalendarHelper.swift" \
  -o "$executable_path"
# Sign with a stable identity when one is available. Ad-hoc ("-") signatures
# change on every rebuild, which silently invalidates the user's Calendar
# permission even though System Settings still shows it as enabled.
identity="${CODESIGN_IDENTITY:-}"
if [[ -z "$identity" ]]; then
  identity="$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null \
    | /usr/bin/awk -F'"' '/Developer ID Application|Apple Development/ { print $2; exit }')"
fi
identity="${identity:--}"
if [[ "$identity" == "-" ]]; then
  echo "warning: no signing identity found; using ad-hoc signing. Calendar access must be re-granted after each rebuild." >&2
fi
/usr/bin/codesign --force --deep --sign "$identity" "$app_dir"

echo "$app_dir"
