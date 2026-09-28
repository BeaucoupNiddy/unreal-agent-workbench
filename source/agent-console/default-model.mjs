import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeModelSettings } from "../unreal-agent-acp/src/model-settings.mjs";

// The bridge (unreal-agent-acp) reads this file when a new chat starts.
// An empty model means "use the provider's own default".
export function normalizeDefaultModel(value = {}) {
  return normalizeModelSettings(value);
}

export async function readDefaultModel(file) {
  try { return normalizeDefaultModel(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError || /Choose a valid (model|provider)\./.test(error.message)) return { provider: "", model: "" };
    throw error;
  }
}

export async function saveDefaultModel(file, value) {
  const settings = normalizeDefaultModel(value);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
  return settings;
}
