# Unreal Agent 1.0.1

This update adds built-in **Claude Code** and **OpenAI Codex** connections to Settings on every installation. They do not include a signed-in account: install Claude Code or Codex separately and run `claude login` or `codex login` in Terminal. Refresh the provider in Settings after signing in. Claude Code chats use the Claude Code CLI; the bundled Codex runner reads a compatible local login file but cannot refresh expired credentials.

**Local models:** Add local models in Settings to connect a running oMLX, Ollama, LM Studio, llama.cpp, vLLM or compatible server. Discover models or specify IDs manually, then use the connection for new chats. Server installation, model downloads and any optional local API key are your responsibility.

Also includes updated provider defaults, local-model inference and background-generation support, improved console/chat experience, and integration tests. Existing chats retain their selected provider/model; changing defaults affects new chats. The app is ad-hoc signed and not notarized. A live paid provider request and clean-account macOS installation have not been tested. See the user guide and validation record.
