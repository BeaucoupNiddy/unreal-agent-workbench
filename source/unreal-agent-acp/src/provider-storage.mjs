import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Copy, never move: the older standalone UI still owns its own settings.
export async function readProviderSettings(current, legacy) {
  try { return JSON.parse(await fs.readFile(current, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let saved;
  try { saved = JSON.parse(await fs.readFile(legacy, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  const value = { provider: saved.provider, model: saved.model };
  await fs.mkdir(path.dirname(current), { recursive: true, mode: 0o700 });
  const temporary = `${current}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    try { await fs.link(temporary, current); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally { await fs.unlink(temporary).catch(() => {}); }
  // If another client won the race, its settings always take precedence.
  return JSON.parse(await fs.readFile(current, "utf8"));
}
