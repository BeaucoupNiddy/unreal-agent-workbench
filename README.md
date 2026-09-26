# Unreal Agent — macOS installer

A ready-to-install package for the Unreal Agent Console: the existing browser front end, Hydra backend, ACP bridge, agent runner, and Apple integrations in one app bundle.

**Download:** use the `.pkg` or `.zip` asset on this repository's **Releases** page. GitHub's green **Code → Download ZIP** contains build source, not a ready-built app.

## Install and launch

1. Download `Unreal-Agent-1.0.0-macOS-arm64.pkg` and open it. Follow Apple's Installer to put **Unreal Agent.app** in `/Applications`.
2. Open **Unreal Agent** from Applications.
3. On first launch, enter your own **OpenRouter API key** and model ID. Alternatively, select **Use existing Codex login** if you already have compatible credentials in `~/.codex/auth.json`.
4. The console opens in your default browser. Add a project folder or create a one-off chat, select a model, and send a prompt.

After setup, opening the app is a one-click launch. The backend starts at login; closing the browser leaves agent tasks running.

**No administrator password option:** download and unzip the release `.zip`, then double-click `Install.command`. It installs the same app into `~/Applications`. Install only one copy.

**Requirements:** Apple Silicon Mac (M1 or later), macOS 14 or later, internet for model requests, and your own working model account. Node, Python, npm, Go, Zed, and ChatGPT do not need to be installed to use the OpenRouter setup. The app bundles its runtime; project-specific tools such as Git or Python are only needed when your tasks use them.

This first release is ad-hoc signed, **not Apple Developer ID signed or notarized**. macOS may block a downloaded installer/app until you explicitly approve it in **System Settings → Privacy & Security → Open Anyway**. You may need to approve both the installer and the app. No Gatekeeper settings need to be disabled. Intel Macs, Windows, and Linux are not supported by these binaries.

## Included

- The developed Agent Console with projects, task history, model selection, attachments, permissions, and live tool activity.
- Pinned Hydra gateway and ACP dependencies, Node runtime, and Unreal Agent runner.
- Native first-run account setup, Keychain storage, per-user startup service registration, and startup checks.
- Optional Apple Notes and Calendar tools, initially off for a new installation. Enable them in Preferences and grant macOS access when asked.
- Installer, ZIP installation kit, uninstall helper, checksums, build provenance, and third-party notices/licenses.

Your own keys, sessions, notes, project paths, and local configuration are not included. Model usage is billed by your selected provider. The Codex credential reader in this pinned runner does not implement login or token refresh: expired credentials must be renewed outside this app. OpenRouter is the built-in setup route for a clean Mac.

Automatic titles and project-memory generation currently use the Codex provider. First-run OpenRouter setup disables those optional features; chat still works. If you have compatible Codex credentials, you can enable them in Preferences.

## Documentation

- [Account setup and everyday use](docs/USER_GUIDE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Updates, migration, and uninstall](docs/MIGRATION.md)
- [Architecture, data, and security](docs/ARCHITECTURE.md)
- [Rebuild and release](docs/BUILDING.md)
- [Verification record](docs/VALIDATION.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Folder contents

`source/` is the clean application source snapshot. `packaging/` contains the native launcher, service setup, build, snapshot, and publishing tools. `test/` checks installer safety and path handling. `docs/` contains recipient and maintainer guides. Locally, `releases/` contains the ready-built artifacts; those large binaries are uploaded as GitHub Release assets rather than committed into Git.
