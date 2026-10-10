# Unreal Agent 1.0.5

**Jambalaya mode:** Settings can switch the console to a Louisiana look, with its own name, icon, wording and a purple, green and gold Mardi Gras palette in light and dark. It adds bead strands, a turning second-line ring, fireflies over a moonlit bayou and colored starter cards. Animations stop when macOS Reduce Motion is on, and only the app's own labels change; your project names, chats and messages are left as they are.

**Readable buttons:** Send, Allow and other primary buttons now pick a text color that contrasts with the accent color, so light themes no longer show dark text on a dark button.

**Subagent savings:** the conversation usage popup estimates what subagents saved, comparing their tokens at the primary model's rate with what they cost on their own models. Assumed cache rates are marked.

Also: the full-size browser screenshot opens in a viewer inside the console that closes with its × button, Escape or a click outside, instead of a window the app could not close. Paid-provider inference and a clean-account macOS installation were not exercised by the automated checks.

# Unreal Agent 1.0.4

**Agent browser:** chats, subagents and swarm members can open web pages, click and type, take screenshots, and read console errors and failed requests, each in its own clean browser context. An installed Chrome, Chromium, Edge or Brave is used when present; otherwise a headless browser is downloaded once on first use. Read-only chats can look at pages but not interact.

**Browser side panel:** a Browser button in the chat header shows the latest page each agent sees and every browser step with its status and errors. Subagents and swarm members appear under their own names. This stays on your Mac and is not sent to the model.

**Signed-in sites:** from the Browser panel, Sign in opens a visible browser window where you log in to a site yourself; agents can then use that session. Forget removes a site. Your own Chrome profile and saved passwords are never read.

**Kaneo:** Settings → Capabilities can connect a Kaneo instance with your own API key, stored in your login keychain. New chats can then list, create, update and comment on tasks, move them between columns and projects, and manage labels. This connection has not yet been tested against a live Kaneo account.

**Always allow:** tool approvals add an "Always allow" choice, saved per server and tool. Settings → Capabilities lists those tools with a Remove button.

Also: projects and chats are easier to tell apart in the sidebar, and the app now shows the actual reason when it cannot start. Paid-provider inference and a clean-account macOS installation were not exercised by the automated checks.

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
