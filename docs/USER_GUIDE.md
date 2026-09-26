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

Automatic title and project-memory generation currently use Codex. They are disabled by setup when you choose OpenRouter because an OpenRouter key alone does not authorize these Codex requests. You can enable them after providing compatible Codex credentials. These features make additional model requests.
