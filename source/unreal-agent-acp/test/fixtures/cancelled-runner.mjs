#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const workspaceIndex = process.argv.indexOf("-workspace");
await writeFile(`${process.argv[workspaceIndex + 1]}/cancelled-turn-edit.txt`, "kept after cancellation\n");
process.on("SIGINT", () => process.exit(130));
setInterval(() => {}, 1000);
