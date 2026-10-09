// In-memory only: history remains authoritative on the server. Bound both the
// number of chats and the size of their transcripts (images can be enormous).
export class RecentTranscripts {
  constructor(limit = 4, maxChars = 4_000_000) {
    this.limit = limit;
    this.maxChars = maxChars;
    this.items = new Map();
  }

  delete(id) { this.items.delete(id); }

  take(id) {
    const value = this.items.get(id);
    this.items.delete(id);
    return value;
  }

  put(id, value) {
    this.delete(id);
    const size = value.entries.reduce((total, entry) => total + (entry.text?.length || 0)
      + (entry.output?.length || 0) + (typeof entry.input === "string" ? entry.input.length : entry.input ? JSON.stringify(entry.input).length : 0)
      + (entry.images || []).reduce((n, image) => n + (image.data?.length || 0), 0), 0);
    if (size > this.maxChars) return;
    this.items.set(id, { ...value, cacheSize: size });
    let total = [...this.items.values()].reduce((n, item) => n + item.cacheSize, 0);
    while (this.items.size > this.limit || total > this.maxChars) {
      const oldest = this.items.keys().next().value;
      total -= this.items.get(oldest).cacheSize;
      this.items.delete(oldest);
    }
  }
}
