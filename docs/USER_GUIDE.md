# Account setup and everyday use

Open the installed Unreal Agent.app. On a new Mac the setup dialog asks for a provider, model ID, and (for OpenRouter) a key. Obtain a key from your own OpenRouter account at https://openrouter.ai/settings/keys. Enter an exact model ID offered to your account; the default follows the model catalog already used by this front end. An unavailable model can be changed in the chat's model selector.

For an existing Codex login, choose that provider. The pinned runner reads the local ChatGPT-authenticated `~/.codex/auth.json`; it cannot perform interactive login or refresh an expired token. An OpenAI API key is not a substitute for this file. The app does not copy another user's credentials or include a subscription.

To reopen account setup, quit/close the launcher if it is already starting, then hold **Option** while opening the installed app. Provider changes apply to newly created chats; existing sessions retain their saved provider. Stop active tasks before changing accounts. The Keychain may ask whether the bundled tools can read the saved key.

## Work

Use **Add project** to select a folder. New chats in that project operate within that folder. One-off chats use the app's own workspace. Choose a model, type a message, attach images when useful, and review tool permission requests. Project-specific executables are not installed by this package.

Closing the browser does not cancel tasks. Reopen the app to reconnect to saved history. The app registers two services for the current macOS user; they start at login. Use the uninstall helper to stop and unregister them.

## Apple Notes and Calendar

New installations leave these integrations off. Enable the ones you want in Preferences. macOS prompts for access when a corresponding tool runs. Notes uses Automation access; Calendar uses Calendar access. Grant only the access you intend to use. These settings do not grant access to someone else's account.

## Optional background features

Automatic title and project-memory generation use the selected model connection when supported. First-run OpenRouter setup disables these optional features; enable them in Preferences if your model/account supports them. These features make additional model requests.

## Claude Code connection (new chats)

Claude Code and OpenAI Codex are listed automatically in Settings → Models on every installation; neither requires adding a custom connection in the app. Authentication is **not bundled**. To use Claude Code, install the official Claude Code CLI on this Mac (https://code.claude.com/docs/en/setup), run `claude login` in Terminal and sign in with your own Claude account. Return to Models and refresh the Claude Code connection. Select it as the default and start a new chat. Your Claude Code installation handles sign-in and account usage; To show subscription percentages, the local console reads your signed-in Claude Code credential and requests account-wide usage directly from Anthropic; only percentages and reset times reach the browser. If the credential or usage endpoint is unavailable, the metric shows Unavailable. The CLI must be installed for the same macOS user running Unreal Agent. Claude Code chats use the CLI agent rather than the pinned Unreal model runner; Read-only disables CLI tools, Workspace confines writes via the macOS sandbox, and Full access is not supported. Claude Code's own tool permissions and transcript differ from Unreal's runner. Its session data is stored by Claude Code under your own home directory. Claude Code is not included in the download.

For Codex, install/sign in to Codex separately using `codex login`. Settings reports whether a compatible local login exists. The pinned runner reads the local auth file directly; it cannot sign in or refresh expired tokens. Neither connection becomes signed in merely by installing Unreal Agent.

## Local model servers (new chats)

Open **Settings → Providers & models → Add local models**. Choose oMLX, Ollama, LM Studio, llama.cpp, vLLM, or a compatible OpenAI-style server and enter its API address. Use **Find models** or enter model IDs manually; you can then choose the connection as your default for new chats. Install, download models, and start the server separately. The server needs `/v1/models` and `/v1/responses` compatibility; agent tasks need a model capable of tool calling. Cached models can remain listed when a server is offline, but cannot be used until the server returns. Optional local API keys and connection settings are saved on this Mac in `~/Library/Application Support/Unreal Agent ACP/local-providers.json` with user-only access. Do not expose an unauthenticated local server to other networks.
