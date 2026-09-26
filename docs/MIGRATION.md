# Updates, migration, and uninstall

## Fresh installation

Install only one copy, using either the `.pkg` (`/Applications`) or the ZIP helper (`~/Applications`). Do not move the app after the first launch: startup services store its installed absolute path.

## Upgrade a packaged installation

1. Finish all active tasks and close the browser.
2. Run the included `Uninstall.command` to stop/unregister the package's services. It preserves your chats, settings, and keys.
3. Move the old app into Trash in Finder, keeping it available for rollback.
4. Install the new app **in the same location** and open it. Your user data is reused.

The standalone package does not install the development checkout's hourly runner updater. Runtime upgrades happen through reviewed package releases. The builder pins the runner and lockfiles.

## Migrate from a developer checkout

The installer deliberately refuses an existing `unreal` agent definition or service that points elsewhere. Do not replace it while a task is running.

After finishing tasks, back up `~/.hydra-acp/config.json` and the two existing plists under `~/Library/LaunchAgents/`. Use `launchctl bootout gui/$(id -u)/local.unreal-agent.agent-console` and the corresponding command for `local.unreal-agent.hydra` to stop the old services. Move those two plists to a backup folder. In Hydra's config, remove only `agents.unreal` so the installer can register the bundled bridge; preserve every other agent and setting. Any `extensions` entry that still references the development checkout should be removed or updated before deleting that checkout. Disable a separately installed `local.unreal-agent.updater` if it is no longer wanted.

Open the packaged app. Existing account settings and session storage are reused. Back up state before migration. Existing optional background generation preferences are preserved unless you explicitly run account setup and choose OpenRouter.

## Uninstall

Run `Uninstall.command`, type `UNINSTALL`, then move the app to Trash. The helper only unregisters plists that identify this packaged app; it does not remove a developer installation.

The helper is in the release ZIP's top folder. With the `.pkg` installation, find the same helper by right-clicking the app in Finder → **Show Package Contents** → `Contents/Resources/Uninstall.command`.

Uninstall preserves:

- `~/.hydra-acp` (history and config)
- `~/Library/Application Support/Unreal Agent ACP`
- `~/Library/Application Support/Unreal Agent Console`
- `~/Library/Application Support/Harness Chat`
- The `Harness Chat OpenRouter` entry in Keychain

If permanently retiring the app, manually remove those folders/Keychain entry only after backing up anything you need. `~/.hydra-acp` may be shared with other clients. The saved `agents.unreal` config can remain for a same-location reinstall; remove that one entry when moving to a different path.

## Rollback

Stop the new services with the helper, restore the previous app to its original path, then reopen it. Restore a backed-up Hydra config only if necessary and while services are stopped. The launcher saves a `config.json.before-installer` copy when it updates an existing config; make your own dated backup before an upgrade as that file can be refreshed on later launches.
