The developed Unreal Agent Console packaged as a self-contained macOS app.

**Apple Silicon, macOS 14+.** Download the `.pkg` for the standard Applications installer, or the `.zip` for installation into your user Applications folder without administrator access. Open Unreal Agent and complete first-run setup with your own OpenRouter key or existing compatible Codex credentials. No developer tools are required for ordinary OpenRouter use.

Includes the front end, Hydra, ACP bridge, Node, runner, optional Apple integrations, documentation, uninstall helper (ZIP), licenses, runtime provenance, and SHA-256 checksums.

The app is ad-hoc signed and is **not notarized**. macOS may require explicit Open Anyway approval. OpenRouter-only setup disables optional Codex-based automatic titles/project memory. The pinned Codex adapter does not implement sign-in or token refresh. Existing developer installs are detected and require deliberate migration.

Validated with 79 automated component/installer tests, native compilation, signature/archive checks, and a clean-HOME HTTP smoke test. A clean macOS account install, Gatekeeper/privacy prompts, and live recipient-provider authentication have not been exercised. See the repository's validation and troubleshooting guides.
