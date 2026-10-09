function appendImages(entry, images) {
  for (const image of images || []) {
    if (!entry.images.some((item) => item.mimeType === image.mimeType && item.data === image.data)) {
      entry.images.push(image);
    }
  }
}

// Replace the optimistic user bubble with Hydra's canonical message ID when
// its echo arrives. This also prevents a resumed event stream from adding the
// same prompt a second time.
export function appendMessageChunk(entries, byMessage, { role, id, text = "", images = [] }) {
  let entry = id ? byMessage.get(id) : null;

  if (role === "user" && entry?.localEcho) {
    appendImages(entry, images);
    return entry;
  }

  if (role === "user" && !entry) {
    const optimistic = [...entries].reverse().find((item) => {
      if (item.type !== "message" || item.role !== "user" || !item.localPending) return false;
      const textMatches = text ? item.text.startsWith(text) : !item.text;
      const imagesMatch = images.length && images.every((image) =>
        item.images.some((local) => local.mimeType === image.mimeType && local.data === image.data));
      return textMatches || imagesMatch;
    });
    if (optimistic) {
      byMessage.delete(optimistic.id);
      optimistic.id = id || optimistic.id;
      optimistic.localPending = false;
      optimistic.localEcho = true;
      byMessage.set(optimistic.id, optimistic);
      appendImages(optimistic, images);
      return optimistic;
    }
  }

  if (!entry) {
    const key = id || `${role}-${entries.length}`;
    entry = { type: "message", role, id: key, text: "", images: [] };
    byMessage.set(key, entry);
    entries.push(entry);
  }
  entry.text += text;
  appendImages(entry, images);
  return entry;
}

// Workspace diffs are synthetic tool calls emitted after the runner exits. By
// then the final assistant message has already streamed, but the diff describes
// work done before that reply. Other tool calls may also arrive after the last
// assistant chunk (and before the diff); keep that trailing activity together
// ahead of the reply, preserving the order of the tool calls on live and replay.
export function appendToolCall(entries, entry) {
  if (entry.kind === "edit" && String(entry.id || "").startsWith("workspace-diff-")) {
    const lastUser = entries.findLastIndex((item) => item.type === "message" && item.role === "user");
    const lastAgent = entries.findLastIndex((item) => item.type === "message" && item.role === "agent");
    if (lastAgent > lastUser) {
      const trailing = entries.slice(lastAgent + 1);
      if (trailing.every((item) => item.type === "tool" || item.type === "thought")) {
        entries.splice(lastAgent, entries.length - lastAgent, ...trailing, entry, entries[lastAgent]);
      } else {
        entries.splice(lastAgent, 0, entry);
      }
      return;
    }
  }
  entries.push(entry);
}
