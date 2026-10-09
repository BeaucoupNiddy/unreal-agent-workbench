# Architecture and data

Finder app → bundled Node launcher → per-user launchd services → Hydra + Agent Console → ACP bridge → bundled Unreal Agent runner → selected model provider.

The app opens the existing front end in the default browser at `http://127.0.0.1:4318/`. It is a native launcher with a local web interface. It is not a separate embedded browser implementation. Hydra and the front end continue running independently of the launcher and browser.

Everything needed for the app lives inside `Unreal Agent.app/Contents`: native launch and Calendar executables, Node, runner, application source, installed npm dependencies, documentation, licenses, and BUILD-INFO.json. Service paths are generated for the recipient's install location, including spaces and XML characters; no developer home directory is embedded in startup configuration.

The package installs no credentials. First-run OpenRouter setup uses the macOS Security API to save a generic Keychain password under service `Unreal Agent OpenRouter` and the current username. The bridge reads it on demand. The key is not written in launchd plists, source, or build metadata. macOS may request Keychain access for the reading tool. Account and model selection are saved in Unreal Agent ACP's `provider-settings.json` file with private permissions.

Two per-user launchd services are registered on first launch: `local.unreal-agent.hydra` and `local.unreal-agent.agent-console`. The launcher checks ownership and preserves other Hydra agents/settings. Conflicting legacy installations cause an actionable error before replacement. Startup uses `kickstart` without `-k` to avoid interrupting an already running task.

User state is outside the app bundle in the locations listed in MIGRATION.md. App removal does not erase user data. The installer does not enable Tailscale, port forwarding, public hosting, or the development auto-updater. The local console has powerful workspace access; keep it bound to loopback. Origin validation protects browser requests, but this is not a multi-user remote hosting product.

Automatic title/project-memory generation uses the configured model connection when supported. First-run OpenRouter setup disables these optional features. The pinned upstream Codex adapter reads existing credentials and does not implement interactive login or refresh.

Legacy `Harness Chat` provider settings and the `Harness Chat OpenRouter` Keychain item are copied on first use and left intact for rollback.
