import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function exclusive(gate, run) {
  for (let tries = 0; ; tries++) {
    try { await fs.mkdir(gate, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST' || tries === 100) throw new Error('Session ownership is busy; retry shortly.', { cause: error }); await pause(10); }
  }
  try { return await run(); } finally { await fs.rmdir(gate); }
}
export async function acquireSessionWriter(dataDir, id) {
  const directory = path.join(dataDir, 'session-writers');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, createHash('sha256').update(id).digest('hex'));
  const token = randomUUID();
  await exclusive(`${file}.gate`, async () => {
    const owner = await fs.readFile(file, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (owner) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('This chat already has an active writer in another connection. Finish or stop that task before continuing.');
      await fs.unlink(file);
    }
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); }
    finally { await handle.close(); }
  });
  return async () => exclusive(`${file}.gate`, async () => {
    const owner = await fs.readFile(file, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (owner?.token === token) await fs.unlink(file);
  });
}
