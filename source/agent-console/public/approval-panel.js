// Keep pending approvals outside the scrolling transcript so the notice and
// the actual choices cannot be separated by tool output or auto-scrolling.
export function renderApprovalPanel(panel, entries, answer, reportError, doc = document) {
  panel.replaceChildren();
  const pending = entries.filter(entry => entry.type === "permission");
  panel.hidden = pending.length === 0;
  for (const entry of pending) {
    const request = entry.request || {};
    const card = doc.createElement("section"); card.className = "permission-card";
    const heading = doc.createElement("strong"); heading.textContent = "Approval needed";
    const description = doc.createElement("p");
    description.textContent = request.toolCall?.title || request.title || "The agent needs your permission to continue.";
    card.append(heading, description);
    const input = request.toolCall?.rawInput;
    if (input != null) {
      const details = doc.createElement("details");
      const summary = doc.createElement("summary"); summary.textContent = "Request details";
      const content = doc.createElement("pre");
      content.textContent = typeof input === "string" ? input : JSON.stringify(input, null, 2);
      details.append(summary, content); card.append(details);
    }
    if (input?.type === "folder-write-access") {
      const hint = doc.createElement("p"); hint.textContent = "Access applies only to the requested folders in this chat.";
      card.append(hint);
    }
    const actions = doc.createElement("div"); actions.className = "permission-actions";
    const options = request.options || request.permissionOptions || [];
    for (const option of options) {
      const button = doc.createElement("button"); button.type = "button";
      button.textContent = option.name || option.label || option.optionId;
      button.addEventListener("click", async () => {
        for (const choice of actions.children) choice.disabled = true;
        try { await answer(entry, option.optionId); }
        catch (error) { reportError(error.message); }
        finally { for (const choice of actions.children) choice.disabled = false; }
      });
      actions.append(button);
    }
    if (!options.length) {
      const warning = doc.createElement("p");
      warning.textContent = "No approval choices were provided. Reconnect the chat to reload this request.";
      actions.append(warning);
    }
    card.append(actions); panel.append(card);
  }
}
