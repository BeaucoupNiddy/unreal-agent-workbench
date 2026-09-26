export class AutoTitleScheduler {
  constructor(regenerate) {
    this.regenerate = regenerate;
    this.pending = new Set();
  }

  track(sessionId) {
    if (sessionId) this.pending.add(sessionId);
  }

  async afterPrompt(sessionId) {
    if (!this.pending.delete(sessionId)) return false;
    try {
      await this.regenerate(sessionId);
      return true;
    } catch (error) {
      // A transient backend failure should not permanently strand the chat
      // with its raw first prompt as the title. Retry after its next turn.
      this.pending.add(sessionId);
      throw error;
    }
  }
}
