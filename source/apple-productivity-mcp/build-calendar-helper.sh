#!/bin/bash
set -euo pipefail

readonly script_dir="$(cd "$(dirname "$0")" && pwd)"
readonly app_dir="${1:-$HOME/Applications/Unreal Agent.app}"
readonly project_dir="$(cd "$script_dir/.." && pwd)"
readonly contents_dir="$app_dir/Contents"
readonly executable_dir="$contents_dir/MacOS"
readonly executable_path="$executable_dir/UnrealAgentCalendar"

/bin/mkdir -p "$executable_dir"
/bin/mkdir -p "$contents_dir/Resources"
/bin/cp "$script_dir/../scripts/Launch Unreal Agent.command" "$contents_dir/Resources/Launch Unreal Agent.command"
/bin/cp "$script_dir/calendar-helper/Info.plist" "$contents_dir/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable UnrealAgent" "$contents_dir/Info.plist"
/usr/libexec/PlistBuddy -c "Set :LSUIElement false" "$contents_dir/Info.plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string UnrealAgent.icns" "$contents_dir/Info.plist"
/usr/bin/xcrun swift "$project_dir/distribution/packaging/generate-app-icon.swift" "$contents_dir/Resources/UnrealAgent.iconset"
/usr/bin/iconutil -c icns "$contents_dir/Resources/UnrealAgent.iconset" -o "$contents_dir/Resources/UnrealAgent.icns"
/bin/rm -r "$contents_dir/Resources/UnrealAgent.iconset"
temp_dir="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf "$temp_dir"' EXIT
/bin/cp "$project_dir/scripts/DesktopLauncher.swift" "$temp_dir/main.swift"
/usr/bin/xcrun swiftc -O -framework AppKit -framework WebKit "$temp_dir/main.swift" "$project_dir/distribution/packaging/AgentWindow.swift" -o "$executable_dir/UnrealAgent"
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
