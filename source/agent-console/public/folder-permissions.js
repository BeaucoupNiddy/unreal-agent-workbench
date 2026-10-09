// Interpret a short, explicit approval only when exactly one visible request
// exists, and it is a folder grant. Never infer consent from arbitrary prose.
export function folderApprovalReply(entries, text, attachments = []) {
  if (attachments.length) return null;
  const pending = entries.filter(entry => entry.type === 'permission');
  if (pending.length !== 1) return null;
  const entry = pending[0];
  if (entry.request?.toolCall?.rawInput?.type !== 'folder-write-access') return null;
  if (!entry.request.options?.some(option => option.optionId === 'allow-folders')) return null;
  const normalized = text.toLowerCase().replace(/[.,!]/g, '').replace(/\s+/g, ' ').trim();
  const replies = new Set([
    'ok', 'okay', 'yes', 'sure', 'approved', 'allow these folders', 'grant access',
    'ok continue', 'okay continue', 'yes continue', 'ok please continue',
    'ok you can do this', 'ok you can do this please move on',
    'okay you can do this please move on', 'yes you can do this please move on'
  ]);
  return replies.has(normalized) ? entry : null;
}
