import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

// Persist UI events before sending. A failed notification remains queued and is
// replayed on the next prompt/client attachment; it cannot hide later tool events.
export class EventDelivery {
  constructor(dataDir) { this.directory = path.join(dataDir, 'event-delivery'); this.sessions = new Map(); }
  async state(id) {
    if (!this.sessions.has(id)) this.sessions.set(id, (async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const key = createHash('sha256').update(id).digest('hex');
      const journal = path.join(this.directory, `${key}.jsonl`), cursorFile = path.join(this.directory, `${key}.cursor.json`);
      const text = await fs.readFile(journal, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
      const cursor = await fs.readFile(cursorFile, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return 0; throw error; });
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid event delivery cursor; restore its backup.');
      const records = [];
      let committedBytes = 0;
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        if (!line) continue;
        if (index === lines.length - 1 && !text.endsWith('\n')) break;
        let record;
        try { record = JSON.parse(line); }
        catch {
          throw new Error('Event journal is corrupt; restore its backup before replay.');
        }
        if (!Number.isSafeInteger(record?.seq) || record.seq !== (records.at(-1)?.seq || 0) + 1 || typeof record.method !== 'string' || !record.params) throw new Error('Invalid event journal record; restore its backup before replay.');
        records.push(record); committedBytes += Buffer.byteLength(line + '\n');
      }
      if (cursor > (records.at(-1)?.seq || 0)) throw new Error('Event journal and cursor backups do not match.');
      if (committedBytes !== Buffer.byteLength(text)) await fs.truncate(journal, committedBytes);
      return { journal, cursorFile, cursor, seq: records.at(-1)?.seq || 0, records: records.filter((record) => record.seq > cursor), queue: Promise.resolve() };
    })());
    return this.sessions.get(id);
  }
  async enqueue(id, method, params, client) {
    const state = await this.state(id);
    const work = state.queue.catch(() => {}).then(async () => {
      const seq = state.seq + 1;
      const record = { seq, method, params: { ...params, _meta: { ...params._meta, 'unreal-agent/event-id': `${id}:${seq}` } } };
      const file = await fs.open(state.journal, 'a', 0o600);
      try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync(); }
      finally { await file.close(); }
      state.seq = seq; state.records.push(record);
      await this.flushState(state, client);
    });
    state.queue = work; await work;
  }
  async flush(id, client) {
    const state = await this.state(id);
    const work = state.queue.catch(() => {}).then(() => this.flushState(state, client));
    state.queue = work; await work;
  }
  async flushState(state, client) {
    while (state.records.length) {
      const record = state.records[0];
      try { await client.notify(record.method, record.params); }
      catch { return; } // Durable retry; event ingestion proceeds independently.
      const temporary = `${state.cursorFile}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, 'w', 0o600);
      try { await handle.writeFile(JSON.stringify(record.seq)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, state.cursorFile);
      state.cursor = record.seq; state.records.shift();
    }
  }
}
