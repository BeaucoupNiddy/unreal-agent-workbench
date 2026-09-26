#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const workspaceIndex = process.argv.indexOf("-workspace");
await writeFile(`${process.argv[workspaceIndex + 1]}/failed-turn-edit.txt`, "kept after failure\n");
process.stderr.write("intentional runner failure\n");
process.exitCode = 1;
