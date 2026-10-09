import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const cache = new Map();
async function digest(file) {
  const stat = await fs.stat(file);
  const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (cache.get(file)?.key === key) return cache.get(file).hash;
  const hash = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  cache.set(file, { key, hash }); return hash;
}
export async function verifyRuntime(liveRunner, officialRunner, extensionRoot) {
  const marker = path.join(path.dirname(liveRunner), '.update-in-progress');
  if (await fs.access(marker).then(() => true, () => false)) throw new Error('The harness pair is being updated. Retry after the update finishes.');
  const info = JSON.parse(await fs.readFile(`${liveRunner}.json`, 'utf8'));
  if (!info.officialBinarySHA256 || await digest(officialRunner) !== info.officialBinarySHA256 || await digest(liveRunner) !== info.binarySHA256) {
    throw new Error('The official harness and live companion do not match their verified build. Rebuild or restore the pair before running a task.');
  }
  const extension = createHash('sha256');
  for (const name of ['runner.patch', 'live_input.go', 'live_input_test.go']) {
    extension.update(name); extension.update(await fs.readFile(path.join(extensionRoot, name)));
  }
  if (extension.digest('hex') !== info.extensionSHA256) throw new Error('The live companion is older than its source. Rebuild it before running a task.');
  if (await fs.access(marker).then(() => true, () => false)) throw new Error('The harness pair is being updated. Retry after the update finishes.');
  return info;
}
