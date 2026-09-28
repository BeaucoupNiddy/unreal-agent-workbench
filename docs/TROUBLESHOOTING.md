# Troubleshooting

## macOS blocks the download

This release is not notarized. After attempting to open the installer or app, use System Settings → Privacy & Security → Open Anyway if macOS offers it. Verify you downloaded from the intended GitHub release and compare the included SHA-256 checksums if needed. Do not disable Gatekeeper or globally remove quarantine protections. Managed Macs may require IT approval.

## Existing installation detected

The launcher refuses to overwrite a different Unreal Agent service or Hydra agent definition. Finish current tasks and follow [MIGRATION.md](MIGRATION.md). This is expected when switching from a development checkout.

## App must be installed first

Do not launch the app directly from Downloads or a mounted disk image. Use the `.pkg`, or the ZIP's `Install.command`, to install it in `/Applications` or `~/Applications`. This also avoids macOS App Translocation changing paths.

## Backend did not become ready / port already in use

The front end binds to `127.0.0.1:4318`. A second development console can occupy that port. Stop the old app using its documented shutdown instructions. The installer does not kill unknown processes.

Logs:

- `~/Library/Logs/local.unreal-agent.hydra.log`
- `~/Library/Logs/local.unreal-agent.agent-console.log`

Startup-only check (Terminal; adjust path if installed in `~/Applications`):

```sh
"/Applications/Unreal Agent.app/Contents/Resources/runtime/bin/node" \
  "/Applications/Unreal Agent.app/Contents/Resources/launch.mjs" --check
```

Opening the app or running this check does not restart a healthy service. Allow up to a minute for initial startup. If a service repeatedly crashes, inspect its log before retrying.

## Models reject requests

Check the account, credit/billing status, provider, and model ID. Hold Option when opening the app to change setup. Create a new chat after changing providers. For OpenRouter, approve the Keychain request if prompted. For Codex, renew expired credentials externally; this runner has no login/refresh implementation. Never paste credentials into a support issue.

## Apple tools fail

Enable the integration in Preferences, then check System Settings → Privacy & Security → Calendars or Automation. Keep the Mac unlocked while responding to permission prompts. The app does not grant these permissions during installation.

## It works on one Mac but not another

The shipped binaries are for Apple Silicon and macOS 14+. Intel/Windows/Linux require separate porting/build work. Developer tools inside a project remain that project's prerequisites. No live provider request is part of the installer's health check: a ready backend does not prove billing or credentials are valid.

## Built-in provider says Sign in required

Neither connection includes credentials. For Claude Code, install the official CLI (https://code.claude.com/docs/en/setup), run `claude login` in Terminal, and refresh Claude Code in Settings. For Codex, install and run `codex login` in Terminal and refresh its status. Use the same macOS account as the app. A Codex login file being present does not prove its token is unexpired; renew it with Codex if requests fail. A local model connection instead requires its separate model server to be running.
