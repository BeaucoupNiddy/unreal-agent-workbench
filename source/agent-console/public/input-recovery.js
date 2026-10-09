const storageKey = 'unrealAgent.pendingInputIds';
export function newInputId(crypto = globalThis.crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function signature(sessionId, text, attachments) {
  const value = JSON.stringify([sessionId, text, attachments]);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ value.charCodeAt(i); }
  return `${value.length}:${a >>> 0}:${b >>> 0}`;
}
function saved(storage) { try { return JSON.parse(storage.getItem(storageKey) || '{}'); } catch { return {}; } }
function write(storage, records) { try { storage.setItem(storageKey, JSON.stringify(records)); } catch { /* Sending remains available when browser storage is disabled. */ } }
export function recoverInputId(sessionId, text, attachments, storage = globalThis.localStorage) {
  const records = saved(storage), key = signature(sessionId, text, attachments);
  if (!records[key]) records[key] = { id: newInputId(), at: Date.now() };
  const recent = Object.fromEntries(Object.entries(records).sort((a, b) => b[1].at - a[1].at).slice(0, 100));
  write(storage, recent); return records[key].id;
}
export function finishInputId(id, storage = globalThis.localStorage) {
  const records = saved(storage);
  for (const [key, value] of Object.entries(records)) if (value.id === id) delete records[key];
  write(storage, records);
}
