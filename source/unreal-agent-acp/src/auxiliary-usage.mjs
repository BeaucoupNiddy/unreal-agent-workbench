import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export async function saveAuxiliaryUsage(dataDir, event) {
  const directory = path.join(dataDir, 'auxiliary-usage');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const id = createHash('sha256').update(`${event.jobId}:${event.responseId}`).digest('hex');
  const file = path.join(directory, `${id}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(event)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
}

export async function readAuxiliaryUsage(dataDir) {
  const directory = path.join(dataDir, 'auxiliary-usage');
  const names = await fs.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const events = [];
  for (const name of names.filter((value) => value.endsWith('.json'))) {
    try {
      const event = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
    } catch (error) {
      // A deleted/corrupt entry must not make all recorded usage inaccessible.
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
  return events;
}
