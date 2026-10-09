import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
export class ConsoleInputs {
  constructor(dataDir) { this.lastAt = 0; this.directory = path.join(dataDir, 'pending-inputs'); }
  sessionDirectory(sessionId) { return path.join(this.directory, createHash('sha256').update(sessionId).digest('hex')); }
  file(sessionId, inputId) { return path.join(this.sessionDirectory(sessionId), `${createHash('sha256').update(inputId).digest('hex')}.json`); }
  async save(sessionId, inputId, text, attachments, delivery = "sending") {
    await fs.mkdir(this.sessionDirectory(sessionId), { recursive: true, mode: 0o700 });
    const destination = this.file(sessionId, inputId);
    const saved = await fs.readFile(destination, 'utf8').then(JSON.parse).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (saved) {
      if (saved.text !== text || JSON.stringify(saved.attachments) !== JSON.stringify(attachments)) throw new Error('Message recovery ID was reused for different content.');
      return saved;
    }
    const at = this.lastAt = Math.max(Date.now(), this.lastAt + 1);
    let record = { sessionId, inputId, text, attachments, delivery, at };
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await fs.readFile(destination, 'utf8'));
      if (existing.text !== text || JSON.stringify(existing.attachments) !== JSON.stringify(attachments)) throw new Error('Message recovery ID was reused for different content.');
      record = existing;
    } finally { await fs.unlink(temporary); }
    return record;
  }
  async setDelivery(sessionId, inputId, delivery) {
    const destination = this.file(sessionId, inputId);
    const record = JSON.parse(await fs.readFile(destination, 'utf8'));
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...record, delivery })); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.rename(temporary, destination); }
    finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async pending(sessionId) {
    const directory = this.sessionDirectory(sessionId);
    const names = await fs.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    const records = await Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => fs.readFile(path.join(directory, name), 'utf8').then(JSON.parse)));
    this.lastAt = Math.max(this.lastAt, ...records.map(record => record.at));
    return records.filter((record) => record.sessionId === sessionId).sort((a, b) => a.at - b.at);
  }
  async complete(sessionId, inputId) { await fs.unlink(this.file(sessionId, inputId)).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  async discard(sessionId) { for (const input of await this.pending(sessionId)) await this.complete(sessionId, input.inputId); }
}
