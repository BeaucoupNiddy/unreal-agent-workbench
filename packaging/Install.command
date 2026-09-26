#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
source_app="$PWD/Unreal Agent.app"
target_app="$HOME/Applications/Unreal Agent.app"
trap 'echo "Installation did not finish. See the README and troubleshooting guide."; read -r -p "Press Return to close."' ERR
if [[ -e "$target_app" ]]; then
  echo "An Unreal Agent app already exists at $target_app. Follow docs/MIGRATION.md before replacing it."
  exit 1
fi
mkdir -p "$HOME/Applications"
/usr/bin/ditto "$source_app" "$target_app"
/usr/bin/open "$target_app"
echo "Installed in $target_app. Complete account setup in the app window."
