import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeModelSettings } from "./model-settings.mjs";

// Share the Console's new-chat defaults so an explicit Settings change can
// override the last-used choices. Do not copy a chat's permission grants.
export async function rememberChatSettings(dataDir, session) {
  const settings = normalizeModelSettings({
    provider: session.provider, model: session.model, thoughtLevel: session.thoughtLevel
  });
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "default-model.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  return settings;
}
