# Harness runtime and recovery

The official Unreal Agent runner and live-input companion are a verified pair. The companion retains upstream scheduling and operation management, accepts live user/reasoning/Stop frames, and exits naturally when an active task becomes idle. Session history is restored for the next task. Claude Code remains a separate CLI route.

Model and permission changes require finishing or stopping the current task. Reasoning changes apply to the next inference request through the live inbox. Read-only mode covers native workspace access and declared read-only external tools. Cancellation stops native operations and requests external-tool cancellation; changes already accepted by an external application may still finish.

Accepted prompts and UI events have local recovery journals and stable IDs. Reopening a chat retries pending input; failed event delivery is replayed without duplicating chunks. Authoritative histories, operation records and attachments are retained. Restore a missing history from backup before continuing that chat. Keep these stores in your normal backups.

Generated titles and project memories use read-only confinement with native tools disabled. Their recorded response usage is included in dashboard totals. Summaries are retrieval aids; original transcripts remain authoritative.

Build provenance records the upstream revision, companion extension hash and signed binary hashes. Startup refuses a mismatched pair. Package builds include the current source; the development updater validates and rolls back the official runner, companion and manifest together. Existing active processes keep their original executable while an update is installed. No restart is performed by the updater.
