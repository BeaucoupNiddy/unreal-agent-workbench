// External tools the user chose to "Always allow", kept across chats as
// "<server>/<tool>" keys. Settings > Capabilities lists and removes them.
import { promises as fs } from "node:fs";
import path from "node:path";

export const toolApprovalsFileName = "tool-approvals.json";
const validKey = (value) => typeof value === "string" && /^[^/\s]{1,120}\/[^/\s]{1,120}$/.test(value);

export async function readToolApprovals(filePath) {
  try {
    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    return [...new Set((Array.isArray(saved?.tools) ? saved.tools : []).filter(validKey))].sort();
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function write(filePath, tools) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ tools: [...tools].sort() }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  return [...tools].sort();
}

export async function addToolApproval(filePath, key) {
  if (!validKey(key)) throw new Error("Invalid tool approval.");
  const tools = new Set(await readToolApprovals(filePath));
  tools.add(key);
  return write(filePath, tools);
}

export async function removeToolApprovals(filePath, keys) {
  const remove = new Set(Array.isArray(keys) ? keys : [keys]);
  return write(filePath, (await readToolApprovals(filePath)).filter((key) => !remove.has(key)));
}
