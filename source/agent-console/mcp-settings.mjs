import { promises as fs } from "node:fs";
import path from "node:path";

export const defaultMcpSettings = Object.freeze({
  appleNotes: true,
  appleCalendar: true
});

export function normalizeMcpSettings(value) {
  return {
    appleNotes: typeof value?.appleNotes === "boolean" ? value.appleNotes : defaultMcpSettings.appleNotes,
    appleCalendar: typeof value?.appleCalendar === "boolean" ? value.appleCalendar : defaultMcpSettings.appleCalendar
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

export function configuredMcpServers(settings, { nodePath, appleServerPath }) {
  const enabled = [];
  if (settings.appleNotes) enabled.push("notes");
  if (settings.appleCalendar) enabled.push("calendar");
  if (!enabled.length) return [];
  return [{
    name: "apple-productivity",
    command: nodePath,
    args: [appleServerPath],
    env: [{ name: "APPLE_MCP_CAPABILITIES", value: enabled.join(",") }]
  }];
}
