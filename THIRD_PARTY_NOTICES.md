# Third-party software

The release bundles Node.js, Unreal Labs' Unreal Agent runner, Hydra ACP CLI/browser, the Agent Client Protocol SDK, mcp-remote, Playwright (`playwright-core`), and their locked dependencies. These components retain their respective copyright and license terms.

- Node.js: https://nodejs.org — complete Node license and bundled dependency notices in `Contents/Resources/licenses/Node-LICENSE.txt`.
- Unreal Agent: https://github.com/unreallabsai/unreal-agent — MIT, Copyright 2026 Unreal Labs; pinned revision `a5f3fd13032737142916523ae4344c392292f9d5`. License in `licenses/Unreal-Agent-LICENSE.txt` inside the app. Go dependency licenses are included alongside it.
- Go runtime: BSD-style license included in `licenses/Go-LICENSE.txt` inside the app.
- Hydra ACP CLI `0.1.191` and browser `0.1.58`: package-declared MIT. Package licenses/notices are retained in the bundled `source/hydra-gateway/node_modules` tree.
- Playwright `playwright-core` `1.63.0`: Apache-2.0, Copyright Microsoft Corporation. Its LICENSE, NOTICE and ThirdPartyNotices.txt are retained in `source/unreal-agent-acp/node_modules/playwright-core`. No browser binary is bundled. When no Chromium-family browser is installed, Playwright's headless Chromium (and its FFmpeg helper) is downloaded from Playwright's official download servers on first browser use, under their own licenses.
- ACP SDK `1.5.0` and mcp-remote: licenses/notices are retained in the bundled `source/unreal-agent-acp/node_modules` tree. Exact transitive versions and integrity hashes are in each component's `package-lock.json`.

Build provenance records the exact runner revision, runtime hashes, and application source hashes. The app does not imply endorsement by Apple, OpenAI, OpenRouter, Hydra, or Unreal Labs. Provider accounts and usage terms remain separate from this package.
