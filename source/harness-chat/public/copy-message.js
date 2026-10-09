import { renderMarkdown } from "./markdown.js";

// Keep Markdown as plain text for code editors, and supply formatted HTML
// for rich-text destinations.
export async function copyMessage(text, clipboard = navigator.clipboard, ClipboardItemType = globalThis.ClipboardItem) {
  if (ClipboardItemType && clipboard?.write) {
    try {
      await clipboard.write([new ClipboardItemType({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([renderMarkdown(text)], { type: "text/html" })
      })]);
      return;
    } catch (error) {
      if (!clipboard.writeText) throw error;
    }
  }
  if (!clipboard?.writeText) throw new Error("Clipboard is unavailable in this browser.");
  await clipboard.writeText(text);
}
