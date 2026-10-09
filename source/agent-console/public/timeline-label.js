// Compact, factual chart labels. The original event title remains available
// as a tooltip; do not invent task names from unrelated parts of a command.
export function timelineToolLabel(title) {
  const text = String(title || "").trim();
  if (!text) return "Tool";
  if (/^view\s+\S/i.test(text)) return "Image";
  if (/^use skill\b/i.test(text)) return "Skill";

  // Bash titles begin with the command, often after a working-directory change.
  const command = text.replace(/^(?:cd\s+(?:"[^"]+"|'[^']+'|[^;&\n]+?)\s*(?:&&|;)\s*)+/i, "").trim();
  if (/^(?:unreal-apply-patch|apply_patch)\b/i.test(command)) return "Edit";
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|verify)(?:\s|$)|^(?:node\s+--test|pytest|cargo\s+test|go\s+test|swift\s+test)\b/i.test(command)) return "Tests";
  if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|cargo\s+build|swift\s+build|make)(?:\s|$)/i.test(command)) return "Build";
  if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:ci|install|add)|pip3?\s+install|brew\s+install)(?:\s|$)/i.test(command)) return "Install";
  if (/^git\b/i.test(command)) return "Git";
  if (/^(?:curl|wget)\b/i.test(command)) return "HTTP";
  if (/^unreal-capability\b/i.test(command)) return "Capability";
  if (/^(?:grep|rg|find|fd|ag)\b/i.test(command)) return "Search";
  if (/^(?:cat|sed|head|tail|ls|pwd|stat|wc|env)\b/i.test(command)) return "Inspect";
  if (/^(?:python3?|node|ruby|bash|sh)\b/i.test(command)) return "Script";
  // Non-command tools already have a concise name; unknown shell commands do not.
  if (/^[A-Za-z][A-Za-z0-9]*(?: [A-Za-z][A-Za-z0-9]*){0,2}$/.test(text)) return text;
  return "Command";
}

// Summaries are plain text in the chart. Remove presentational Markdown markers,
// not content; the original provider text remains intact in stored turn history.
export function timelineReasoningText(text) {
  return String(text || "").replace(/\*\*(.*?)\*\*/gs, "$1").replace(/__(.*?)__/gs, "$1")
    .replace(/(^|\n)\s{0,3}#{1,6}\s+/g, "$1").trim();
}
