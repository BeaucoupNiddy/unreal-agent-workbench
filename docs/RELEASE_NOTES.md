# Unreal Agent 1.0.3

**Subagents:** Settings → Agents sets the primary agent for new chats and the subagents it may delegate to. Five built-in subagents are included; each has its own provider, model, reasoning effort and access (Read only, or Can edit files within the workspace sandbox). A delegation slider controls how readily the primary agent hands work off, live task cards show each subagent's progress, and API charges from subagents are counted in the chat's usage.

**Swarms:** optional swarms let several subagents work on one problem together and message each other while they work.

**Steering and reading:** messages sent while a task is running are delivered to the running agent instead of waiting for it to finish. Interim agent messages appear as compact progress notes, and the transcript keeps your place when you scroll up during a task.

**Context compaction:** the bundled runner moves to upstream Unreal Agent `a5f3fd1`, which automatically summarizes older context in long tasks once a model's compaction threshold is reached, while running tools keep going. Thresholds come from the runner's model settings for OpenAI, Codex, Anthropic and Fireworks models. OpenRouter models get half their context window, capped at 500k tokens; models with 40k tokens of context or less, and local models, run without compaction. The summary is hidden from the transcript and a short progress note appears instead. Reasoning summaries from the new runner format continue to display.

Also adds an OpenRouter key field in Settings and a shared model option for subagents. Paid-provider inference and a clean-account macOS installation were not exercised by the automated checks.

# Unreal Agent 1.0.2

Harness reliability fixes: persistent task input now supports reasoning updates and upstream hard Stop; accepted prompts and UI events survive connection failures; authoritative histories and attachments no longer expire with logs. Model and permission changes require finishing or stopping the current task. Read-only mode covers external tools, with cooperative cancellation for in-flight external calls.

Titles and project memories run with native tools disabled and read-only confinement. Their response usage is recorded in totals, repeated summaries of unchanged chats are skipped, and history search falls back to the original transcript when a summary misses the requested detail or is stale. Each session permits one harness writer.

The packaged official runner and live companion are built and verified as a pair, with binary/source hashes. The development updater checks and rolls back both binaries and their manifest together. The companion remains persistent during an active task and exits naturally when idle. Paid-provider inference and a clean-account macOS installation were not exercised by these checks.

# Unreal Agent 1.0.1

This update adds built-in **Claude Code** and **OpenAI Codex** connections to Settings on every installation. They do not include a signed-in account: install Claude Code or Codex separately and run `claude login` or `codex login` in Terminal. Refresh the provider in Settings after signing in. Claude Code chats use the Claude Code CLI; the bundled Codex runner reads a compatible local login file but cannot refresh expired credentials.

**Local models:** Add local models in Settings to connect a running oMLX, Ollama, LM Studio, llama.cpp, vLLM or compatible server. Discover models or specify IDs manually, then use the connection for new chats. Server installation, model downloads and any optional local API key are your responsibility.

Also includes updated provider defaults, local-model inference and background-generation support, improved console/chat experience, and integration tests. Existing chats retain their selected provider/model; changing defaults affects new chats. The app is ad-hoc signed and not notarized. A live paid provider request and clean-account macOS installation have not been tested. See the user guide and validation record.
