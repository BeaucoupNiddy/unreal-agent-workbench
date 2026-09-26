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
/usr/bin/codesign --force --deep --sign - "$app_dir"

echo "$app_dir"
