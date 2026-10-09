#!/usr/bin/env node
import { appendFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const request = JSON.parse(process.argv.at(-1));
if (!process.argv.includes('-live-input')) throw new Error('Expected live-input flag');
const workspace = process.argv[process.argv.indexOf('-workspace') + 1];
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const message = (text) => emit({ Kind: 'model_response', Data: { Response: { Output: [
  { Type: 'message', Data: { ID: text, Phase: 'final', Text: text } }
] } } });
await appendFile(`${workspace}/launches.jsonl`, `${JSON.stringify({ pid: process.pid, session: request.session_id })}\n`);
const initial = request.messages;
const longTool = initial[0].content === 'long tool';
process.on('SIGINT', () => {
  void appendFile(`${workspace}/interrupted.txt`, 'SIGINT\n').then(() => process.exit(130));
});
async function input(value) {
  await appendFile(`${workspace}/inputs.jsonl`, `${JSON.stringify(value)}\n`);
  emit({ Kind: 'input', Data: { Kind: 'external', ID: value.message_id, Payload: value.content } });
}
for (const value of initial) await input(value);
if (initial[0].content === 'exit race') {
  message('closing now');
  process.stdout.write('', () => process.exit(0));
} else if (!longTool) {
  message(`Recovered: ${initial.map((m) => m.content).join(' | ')}`);
  process.stdout.write('', () => process.exit(0));
} else {
  emit({ Kind: 'model_response', Data: { Response: { Output: [{ Type: 'tool_call',
    Data: { CallID: 'live-tool', Name: 'Bash', Arguments: JSON.stringify({ command: 'long tool' }) } }] } } });
  emit({ Kind: 'tool_call_status', Data: { CallID: 'live-tool',
    Operations: [{ ID: 'live-op', Type: 'shell', Status: 'ready' }] } });
  await appendFile(`${workspace}/tool-active.txt`, 'running\n');
  const lines = createInterface({ input: process.stdin });
  // Serialize frames like the real input scanner, preserving user order.
  let pending = Promise.resolve();
  lines.on('line', (line) => {
    pending = pending.then(async () => {
      const frame = JSON.parse(line);
      if (frame.control) {
        await appendFile(`${workspace}/controls.jsonl`, JSON.stringify(frame.control) + "\n");
        if (frame.control.mode === "hard") process.exit(0);
        return;
      }
      for (const value of frame.messages) {
        await input(value);
        message(`Live steering: ${value.content}`);
      }
    });
  });
  while (await access(`${workspace}/release-tool.txt`).then(() => false, () => true)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await pending;
  emit({ Kind: 'tool_call_status', Data: { CallID: 'live-tool',
    Operations: [{ ID: 'live-op', Type: 'shell', Status: 'completed' }] } });
  message('Tool completed without restart');
  process.stdout.write('', () => process.exit(0));
}
