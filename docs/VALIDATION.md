# Verification record — 1.0.5

Validation is performed on the Apple Silicon development Mac. This release has not been tested in a separate clean macOS account or VM and has not been notarized.

Checks used for this release (1.0.5):

- Installer tests: valid launchd XML with spaces/special characters; preserving other Hydra settings; refusing legacy service/agent conflicts without modifying files; fresh and same-location registration planning.
- Component checks: Agent Console, ACP bridge (including local providers and Claude/Codex status), Apple Productivity MCP, and Harness Chat syntax/tests against the staged source and clean lockfile dependencies.
- Build: native Swift compilation, pinned runner revision/architecture validation, bundled runtime execution, ad-hoc signature verification, package and ZIP creation.
- Distribution checks: clean temporary HOME for front-end and Hydra HTTP smoke tests; archive integrity and installer payload inspection; scanning distributable first-party files for developer paths and credential patterns; SHA-256 release manifest.

A live paid model request is not run on behalf of a recipient. Their credentials, billing, and model availability must be established during first use. macOS first-run privacy and Gatekeeper prompts require recipient interaction and cannot be certified by the automated checks. Optional Apple integrations retain macOS permission requirements.
