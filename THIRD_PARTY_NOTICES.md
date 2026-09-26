# Third-party software

The release bundles Node.js, Unreal Labs' Unreal Agent runner, Hydra ACP CLI/browser, the Agent Client Protocol SDK, mcp-remote, and their locked dependencies. These components retain their respective copyright and license terms.

- Node.js: https://nodejs.org — complete Node license and bundled dependency notices in `Contents/Resources/licenses/Node-LICENSE.txt`.
- Unreal Agent: https://github.com/unreallabsai/unreal-agent — MIT, Copyright 2026 Unreal Labs; pinned revision `1b9f778453f411c029b39b85102aaefb95e7e48d`. License in `licenses/Unreal-Agent-LICENSE.txt` inside the app. Go dependency licenses are included alongside it.
- Go runtime: BSD-style license included in `licenses/Go-LICENSE.txt` inside the app.
- Hydra ACP CLI `0.1.191` and browser `0.1.58`: package-declared MIT. Package licenses/notices are retained in the bundled `source/hydra-gateway/node_modules` tree.
- ACP SDK `1.5.0` and mcp-remote: licenses/notices are retained in the bundled `source/unreal-agent-acp/node_modules` tree. Exact transitive versions and integrity hashes are in each component's `package-lock.json`.

Build provenance records the exact runner revision, runtime hashes, and application source hashes. The app does not imply endorsement by Apple, OpenAI, OpenRouter, Hydra, or Unreal Labs. Provider accounts and usage terms remain separate from this package.
