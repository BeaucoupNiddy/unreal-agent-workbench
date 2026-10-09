# Live-input runner companion

This is a small, reproducible extension of the **official** Unreal Agent runner
CLI, not a fork of its scheduler. The core coordinator, inbox, providers, tools,
sandbox, event log and cache behavior are upstream. `runner.patch` adds one CLI
flag and input-reader lifecycle; `live_input.go` forwards JSONL user messages to
`Inbox.Submit`. The official one-shot binary remains untouched and is still used
for background generation and as a compatibility fallback.

## Build

Requires Git, Python 3, and Go 1.27+ (macOS/Linux):

```sh
python3 live-runner/build.py
# Or reuse a clean official checkout without another Git clone:
python3 live-runner/build.py --source /path/to/unreal-agent
```

Default upstream revision: `a5f3fd13032737142916523ae4344c392292f9d5`.
A build applies the CLI patch in a temporary copy of clean source, checks formatting,
runs the runner/coordinator/inbox race tests and vet, builds, verifies the flag,
and atomically publishes `unreal-agent-acp/runtime/unreal-agent-live-runner` plus
its revision/extension/binary hash manifest. Build artifacts are ignored by Git.
The updater can supply a validated descendant with `--revision`; a patch or test
failure prevents installation rather than silently replacing live input with a
one-shot runner. The build does not need provider credentials or live inference.

## Compaction limits

`-model-settings <file>` names a settings file in the upstream format. It is
used only when the built-in and user settings give the selected model no
compaction threshold. The bridge uses it to give OpenRouter models half their
context window as a threshold.

## Protocol and lifetime

```sh
unreal-agent-live-runner -workspace /project -session-directory /state \
  -live-input '{"session_id":"chat","messages":[{"role":"user","content":"Initial task","message_id":"<UUID>"}]}'
```

While the task runs, stdin accepts one frame per line:

```json
{"messages":[{"role":"user","content":"Change direction","message_id":"<UUID>"}]}
```

User-message frames permit 1–64 messages, bounded to 4 MiB. A separate restricted
`control` frame supports reasoning settings and explicit hard Stop through the
upstream inbox; model/provider/permission changes are not permitted on this channel. The initial request still configures the model,
reasoning and tools. Output remains upstream session JSONL. A durable external
`input` event acknowledges its UUID; successful pipe writes alone do not. Replaying
an initial UUID already in the restored session emits `live_input_ack` without
another user message or model invocation.

A task still exits naturally when the upstream coordinator is idle. Steering
received while tools run uses the same coordinator/process and can supersede the
model request while operations continue. Steering racing natural exit is replayed
in the same persisted session with stable IDs. This is persistent **during the
active task**, not a new always-running agent/session workflow.

Stop/SIGINT, a broken input channel, malformed input, or provider errors terminate
the task and clean up its operations. Stdin file descriptors are duplicated,
close-on-exec, and made pollable so reader shutdown cannot hang on macOS blocking
pipes. Only the upstream model-request cancellation path handles normal steering.

The bridge automatically selects the workspace-built companion. An explicit
`UNREAL_AGENT_LIVE_RUNNER` selects another companion; an explicit one-shot
`UNREAL_AGENT_RUNNER` without that setting, custom test runners, and Claude Code
retain the compatibility path. A missing default development build fails clearly
unless `UNREAL_AGENT_ALLOW_LEGACY_RUNNER=1` explicitly permits the old behavior. An explicitly
configured missing companion fails clearly. The package builder bundles and signs
both binaries and sets both runner paths.

## Tests

`live_input_test.go` is copied into the upstream runner package during a build.
It covers validation, order/deduplication, steering with a running real shell,
in-flight model cancellation, durable duplicate recovery, channel EOF, and reader
shutdown, live reasoning/Stop controls, and concurrent-writer exclusion. ACP tests additionally cover multiple steering prompts, startup/exit
races, Stop and clean completion. With the companion built, `npm run check` in
`unreal-agent-acp` also runs an offline end-to-end test using the actual binary,
real Bash, production bridge, and a local fake Responses SSE server. It verifies
same-PID steering, usage, session resume and cancellation cleanup. Inside the
harness's sandbox it cannot nest sandbox-exec; from a normal macOS terminal it
also exercises the workspace sandbox. Without a build only that binary test skips.
