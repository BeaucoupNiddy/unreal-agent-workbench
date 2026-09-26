import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const ignoredDirectories = new Set([
  ".git", ".hg", ".svn", ".harness", "node_modules", ".venv", "venv",
  "dist", "build", "target", ".next", ".turbo", "coverage", "vendor"
]);
const ignoredUnrealGeneratedDirectories = new Set(["binaries", "deriveddatacache", "intermediate"]);
const ignoredBinaryExtensions = new Set([
  ".uasset", ".umap", ".ubulk", ".uexp", ".uptnl", ".pak",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".dds", ".exr",
  ".wav", ".mp3", ".ogg", ".flac", ".aac", ".m4a", ".mp4", ".mov", ".avi", ".mkv",
  ".zip", ".7z", ".rar"
]);
const maximumFileBytes = 2 * 1024 * 1024;
const maximumSnapshotBytes = 32 * 1024 * 1024;
const maximumFiles = 5000;
const maximumScannedEntries = 20000;

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

async function visit(root, directory, snapshot, budget, previous) {
  if (snapshot.size >= maximumFiles || budget.bytesIncluded >= maximumSnapshotBytes || budget.entries >= maximumScannedEntries) return;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (snapshot.size >= maximumFiles || budget.bytesIncluded >= maximumSnapshotBytes || budget.entries >= maximumScannedEntries) break;
    budget.entries += 1;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const name = entry.name.toLowerCase();
      const generatedUnrealDirectory = ignoredUnrealGeneratedDirectories.has(name) || (directory === root && name === "saved");
      if (!ignoredDirectories.has(name) && !generatedUnrealDirectory) await visit(root, absolute, snapshot, budget, previous);
      continue;
    }
    if (!entry.isFile()) continue;
    if (ignoredBinaryExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    let stat;
    try { stat = await fs.stat(absolute); }
    catch { continue; }
    if (stat.size > maximumFileBytes || budget.bytesIncluded + stat.size > maximumSnapshotBytes) continue;
    budget.bytesIncluded += stat.size;
    const relative = path.relative(root, absolute);
    const oldFile = previous?.get(relative);
    if (oldFile && oldFile.size === stat.size && oldFile.mtimeMs === stat.mtimeMs && oldFile.ctimeMs === stat.ctimeMs) {
      snapshot.set(relative, oldFile);
      continue;
    }
    let content;
    try { content = await fs.readFile(absolute); }
    catch { continue; }
    if (looksBinary(content)) continue;
    snapshot.set(relative, {
      path: absolute,
      text: content.toString("utf8"),
      hash: createHash("sha256").update(content).digest("hex"),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs
    });
  }
}

export async function snapshotWorkspace(root, previous) {
  const snapshot = new Map();
  await visit(root, root, snapshot, { entries: 0, bytesIncluded: 0 }, previous);
  return snapshot;
}

export function workspaceDiff(before, after) {
  const changes = [];
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const name of [...names].sort()) {
    const oldFile = before.get(name);
    const newFile = after.get(name);
    if (oldFile?.hash === newFile?.hash) continue;
    changes.push({
      type: "diff",
      path: newFile?.path || oldFile?.path,
      oldText: oldFile?.text ?? null,
      newText: newFile?.text ?? ""
    });
  }
  return changes;
}
