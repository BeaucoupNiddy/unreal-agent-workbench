import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

// Resolve existing ancestors even when the requested folder does not exist yet.
// Never widen the grant to that ancestor: retain the complete requested suffix.
export async function canonicalFolder(value) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Folder paths must be non-empty strings without control characters.');
  }
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
  if (!path.isAbsolute(expanded)) throw new Error('Use absolute folder paths or ~/ paths.');
  const absolute = path.resolve(expanded);
  let ancestor = absolute;
  const suffix = [];
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!(await fs.stat(real)).isDirectory()) throw new Error('Write access must target a folder, not a file.');
      const resolved = path.join(real, ...suffix);
      if (resolved === path.parse(resolved).root) throw new Error('Request specific folders, not the filesystem root.');
      return resolved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // A dangling symlink must not be treated as a new, ordinary folder.
      const stat = await fs.lstat(ancestor).catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
      if (stat?.isSymbolicLink()) throw new Error('Cannot grant access to a dangling symlink.');
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

export async function requestFolderAccess(session, request, commit) {
  if (session.permissionMode !== 'workspace-write') throw new Error('Folder write grants require Workspace permissions. Read-only remains read-only.');
  if (!session.activeClient || !session.activeTurn) throw new Error('Folder approval is unavailable. Open this chat in Unreal Agent Console or Zed and try again.');
  if (!Array.isArray(request.folders) || !request.folders.length || request.folders.length > 16) throw new Error('Request between 1 and 16 specific folders.');
  if (typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 2000) throw new Error('Include a short reason for folder write access.');
  const turn = session.activeTurn;
  const generation = session.capabilityGeneration || 0;
  const folders = [...new Set(await Promise.all(request.folders.map(canonicalFolder)))];
  const current = session.writableFolders || [];
  const needed = folders.filter(folder => !current.includes(folder));
  if (!needed.length) return { approved: true, folders, restartRequired: false };
  if (turn.cancelled || session.cancelled) throw new Error('The task was cancelled; no folder access was granted.');
  const response = await session.activeClient.request('session/request_permission', {
    sessionId: session.id,
    toolCall: {
      toolCallId: `folder-write-${randomUUID()}`,
      title: `Grant write access for this chat:\n${needed.join('\n')}\n\n${request.reason.trim()}`,
      kind: 'other', status: 'pending',
      locations: needed.map(folder => ({ path: folder })),
      rawInput: { type: 'folder-write-access', folders: needed, reason: request.reason.trim() }
    },
    options: [
      { optionId: 'allow-folders', name: 'Allow these folders for this chat', kind: 'allow_always' },
      { optionId: 'reject', name: 'Deny these folders', kind: 'reject_once' }
    ]
  });
  if (generation !== (session.capabilityGeneration || 0) || session.activeTurn !== turn || turn.cancelled || session.cancelled) {
    throw new Error('The task was cancelled while awaiting approval; no folder access was granted.');
  }
  if (response?.outcome?.outcome !== 'selected' || response.outcome.optionId !== 'allow-folders') throw new Error('Folder write access was not approved.');
  // The target may have changed while the user was reviewing the request.
  for (const folder of needed) {
    if (await canonicalFolder(folder) !== folder) throw new Error('A requested folder changed during approval. Request access again.');
  }
  if (generation !== (session.capabilityGeneration || 0) || session.activeTurn !== turn || turn.cancelled || session.cancelled) {
    throw new Error('The task was cancelled while awaiting approval; no folder access was granted.');
  }
  await commit(needed, turn);
  return { approved: true, folders, restartRequired: true, message: 'Access approved. The harness will resume automatically with these folders writable after active tools finish. Do not start more tools in this process.' };
}
