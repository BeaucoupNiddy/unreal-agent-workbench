import { promises as fs } from "node:fs";
import path from "node:path";

export const generationModels = [
  { id: "gpt-6-luna", label: "Luna 6", description: "Fast and economical" },
  { id: "gpt-6-sol", label: "Sol 6", description: "Balanced" },
  { id: "gpt-6-astra", label: "Astra 6", description: "Most capable" }
];

const allowedModels = new Set(generationModels.map((model) => model.id));
export const defaultGenerationSettings = Object.freeze({
  memoryEnabled: true,
  memoryModel: "gpt-6-luna",
  titleEnabled: true,
  titleModel: "gpt-6-luna"
});

export function normalizeGenerationSettings(value = {}) {
  return {
    memoryEnabled: value.memoryEnabled !== false,
    memoryModel: allowedModels.has(value.memoryModel) ? value.memoryModel : defaultGenerationSettings.memoryModel,
    titleEnabled: value.titleEnabled !== false,
    titleModel: allowedModels.has(value.titleModel) ? value.titleModel : defaultGenerationSettings.titleModel
  };
}

export async function readGenerationSettings(file) {
  try { return normalizeGenerationSettings(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return { ...defaultGenerationSettings };
    throw error;
  }
}

export async function saveGenerationSettings(file, value) {
  const settings = normalizeGenerationSettings(value);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
  return settings;
}
