import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeKaneoUrl } from "./kaneo.mjs";

export const defaultMcpSettings = Object.freeze({
  appleNotes: true,
  appleCalendar: true,
  kaneo: false,
  kaneoUrl: ""
});

function kaneoUrl(value) {
  try { return normalizeKaneoUrl(value); }
  catch { return ""; }
}

export function normalizeMcpSettings(value) {
  return {
    appleNotes: typeof value?.appleNotes === "boolean" ? value.appleNotes : defaultMcpSettings.appleNotes,
    appleCalendar: typeof value?.appleCalendar === "boolean" ? value.appleCalendar : defaultMcpSettings.appleCalendar,
    kaneo: typeof value?.kaneo === "boolean" ? value.kaneo : defaultMcpSettings.kaneo,
    kaneoUrl: kaneoUrl(value?.kaneoUrl)
  };
}

export async function readMcpSettings(filePath) {
  try {
    return normalizeMcpSettings(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { ...defaultMcpSettings };
    throw error;
  }
}

export async function saveMcpSettings(filePath, value) {
  const settings = normalizeMcpSettings(value);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
  return settings;
}

export function configuredMcpServers(settings, { nodePath, appleServerPath, kaneoServerPath }) {
  const servers = [];
  const enabled = [];
  if (settings.appleNotes) enabled.push("notes");
  if (settings.appleCalendar) enabled.push("calendar");
  if (enabled.length) servers.push({
    name: "apple-productivity",
    command: nodePath,
    args: [appleServerPath],
    env: [{ name: "APPLE_MCP_CAPABILITIES", value: enabled.join(",") }]
  });
  // The Kaneo API key stays in the keychain; only the address travels with the chat.
  if (settings.kaneo && settings.kaneoUrl && kaneoServerPath) servers.push({
    name: "kaneo",
    command: nodePath,
    args: [kaneoServerPath],
    env: [{ name: "KANEO_BASE_URL", value: settings.kaneoUrl }]
  });
  return servers;
}
