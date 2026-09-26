#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { acp, createAgentApp, UnrealAgentBridge } from "../src/bridge.mjs";

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const bridge = new UnrealAgentBridge();
const connection = createAgentApp(bridge).connect(acp.ndJsonStream(output, input));

const shutdown = () => bridge.close().finally(() => process.exit());
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try { await connection.closed; }
finally { await bridge.close(); }
