#!/bin/bash
set -euo pipefail
printf 'This stops Unreal Agent tasks and removes its installed startup services. Chats and credentials are preserved.\n'
read -r -p 'Type UNINSTALL to continue: ' answer
[[ "$answer" == "UNINSTALL" ]] || exit 0
for label in local.unreal-agent.agent-console local.unreal-agent.hydra; do
  service_file="$HOME/Library/LaunchAgents/$label.plist"
  if [[ -f "$service_file" ]] && /usr/bin/grep -q 'Unreal Agent.app/Contents/Resources' "$service_file"; then
    /bin/launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    mkdir -p "$HOME/.Trash"
    mv "$service_file" "$HOME/.Trash/$label.$(date +%s).plist"
  fi
done
printf 'Services removed. Move the installed Unreal Agent.app to Trash in Finder. Your chats and Keychain remain intact.\n'
read -r -p 'Press Return to close.'
