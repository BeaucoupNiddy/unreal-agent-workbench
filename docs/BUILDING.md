# Build and publish

These instructions are for maintainers. Recipients use the ready-built Release assets and do not need a compiler or package manager.

## Build host

Use an Apple Silicon Mac with macOS 14+, Xcode Command Line Tools (`xcode-select --install`), Python 3.11+, Node 22+ with npm, Git, and Go compatible with the pinned runner's go.mod. The inaugural package bundles Node 26.8.1 and the exact runner commit below. Download runtime inputs only from their official projects. Node binary distributions include the full LICENSE file; verify their vendor SHA256SUMS before building.

```sh
git clone https://github.com/unreallabsai/unreal-agent.git /tmp/unreal-runner-source
git -C /tmp/unreal-runner-source checkout 1b9f778453f411c029b39b85102aaefb95e7e48d
cd /tmp/unreal-runner-source
go mod download
go build -trimpath -o /tmp/unreal-agent-runner ./cmd/unreal-agent-runner
```

From this distribution folder (the root of the published standalone repository):

```sh
node --test test/*.test.mjs
python3 packaging/build.py \
  --node /absolute/path/to/node \
  --node-license /absolute/path/to/node-distribution/LICENSE \
  --runner /tmp/unreal-agent-runner \
  --runner-source /tmp/unreal-runner-source
```

The build checks architecture and runner revision, copies only the source snapshot, installs dependencies from lockfiles with lifecycle scripts disabled, runs the four component check suites, compiles the launchers, includes third-party licenses, ad-hoc signs the app, and produces `releases/*.pkg`, `releases/*.zip`, `BUILD-INFO.json`, and `SHA256SUMS.txt`. It replaces only its own `build/` staging directory. npm/Go need network access during the first build; the resulting app needs no dependency downloads on install.

For a development workspace, refresh the snapshot with `python3 distribution/packaging/snapshot.py` before building. That script expects the parent workbench component directories and excludes node_modules, hidden files, generated output, and developer README files. The standalone published repository already contains the snapshot and does not need this step.

`--offline-deps /path/to/component-tree` is an explicit maintainer option for a previously installed dependency tree whose lockfiles match. Release builds should use the default clean `npm ci` path. Source hashes, runtime hashes, and dependency mode are recorded in BUILD-INFO.json.

## Signing

`build.py` signs with `--sign-identity`, else `$CODESIGN_IDENTITY`, else the first *Developer ID Application* or *Apple Development* identity in your keychain, and falls back to ad-hoc (`-`). Use a stable identity for any build you install yourself: an ad-hoc signature changes on every rebuild, which silently invalidates the Calendar privacy grant (System Settings still shows it enabled, but access is denied). An *Apple Development* signature embeds your Apple ID email, so pass `--sign-identity -` for public releases unless you use Developer ID. The same rule applies to `apple-productivity-mcp/build-calendar-helper.sh`.

Ad-hoc signing verifies the app's internal code integrity but does not establish a trusted publisher. For a fully smooth public download experience, a maintainer must use their own Apple Developer ID Application/Installer identities, apply appropriate hardened-runtime signing, notarize the app/package with Apple, staple the ticket, and retest on a clean Mac. The supplied build does not claim notarization and never asks recipients to disable Gatekeeper.

## GitHub publication

`packaging/publish.py` uses Git's configured credential helper, verifies the authenticated account, creates a **private** `unreal-agent-workbench` repository if absent, commits only the distribution source/docs, pushes `main`, and uploads the built files to a GitHub Release. It does not print or write credential values. It refuses to overwrite an existing remote main branch with different content. The build binaries remain Release assets, not Git blobs.

```sh
python3 packaging/publish.py --owner BeaucoupNiddy --repo unreal-agent-workbench
```

For future versions, update VERSION in build.py, update the release documentation and validation record, rebuild, and publish a reviewed new release. Reusing an existing published tag is refused. The existing repository visibility is not changed by the publisher; review it in GitHub settings before uploading assets.
