import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { canonicalFolder, requestFolderAccess } from '../src/folder-access.mjs';
import { UnrealAgentBridge } from '../src/bridge.mjs';
import { CapabilityBroker } from '../src/mcp.mjs';
import { sandboxLaunch } from '../src/sandbox.mjs';
const approved = { outcome: { outcome: 'selected', optionId: 'allow-folders' } };
const reason = 'Docker build cache and app configuration';
async function setup(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'folder-access-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'Application Support', 'Ochsner Kaneo');
  const session = { id: 'folder-session', cwd: root, permissionMode: 'workspace-write', writableFolders: [],
    activeTurn: { cancelled: false }, activeClient: { request: async () => approved } };
  return { root, folder, session };
}

test('canonicalizes tilde, existing symlinks and missing folders without granting their parents', async t => {
  const { root, folder } = await setup(t);
  assert.equal(await canonicalFolder(folder), folder);
  assert.equal(await canonicalFolder('~/.docker/buildx'), path.join(await fs.realpath(homedir()), '.docker/buildx'));
  await fs.symlink(root, path.join(root, 'alias'));
  assert.equal(await canonicalFolder(path.join(root, 'alias', 'new', 'child')), path.join(root, 'new', 'child'));
  for (const bad of ['', 'relative', '/', '/a\npath', null]) await assert.rejects(canonicalFolder(bad));
  await fs.writeFile(path.join(root, 'file'), 'x');
  await assert.rejects(canonicalFolder(path.join(root, 'file')), /folder/);
  await fs.symlink(path.join(root, 'missing'), path.join(root, 'dangling'));
  await assert.rejects(canonicalFolder(path.join(root, 'dangling')), /dangling/);
});

test('approval displays exact folders and reason; only explicit folder option commits', async t => {
  const { folder, session } = await setup(t);
  let wire, committed;
  session.activeClient.request = async (method, params) => { assert.equal(method, 'session/request_permission'); wire = params; return approved; };
  const result = await requestFolderAccess(session, { folders: [folder, folder], reason }, async folders => { committed = folders; });
  assert.deepEqual(committed, [folder]);
  assert.deepEqual(wire.toolCall.rawInput, { type: 'folder-write-access', folders: [folder], reason });
  assert.ok(wire.toolCall.title.includes(folder)); assert.ok(wire.toolCall.title.includes(reason));
  assert.equal(result.restartRequired, true);
  for (const response of [{ outcome: { outcome: 'cancelled' } }, { outcome: { outcome: 'selected', optionId: 'allow-always' } }, { outcome: { outcome: 'selected', optionId: 'reject' } }]) {
    session.activeClient.request = async () => response;
    await assert.rejects(requestFolderAccess(session, { folders: [folder], reason }, () => assert.fail('unexpected grant')), /not approved/);
  }
});

test('read-only, invalid and unavailable requests never grant access', async t => {
  const { folder, session } = await setup(t);
  const commit = () => assert.fail('unexpected grant');
  session.permissionMode = 'read-only';
  await assert.rejects(requestFolderAccess(session, { folders: [folder], reason }, commit), /Workspace/);
  session.permissionMode = 'workspace-write';
  for (const request of [{ folders: [], reason }, { folders: [folder] }, { folders: ['/'], reason }, { folders: new Array(17).fill(folder), reason }]) {
    await assert.rejects(requestFolderAccess(session, request, commit));
  }
  session.activeClient = null;
  await assert.rejects(requestFolderAccess(session, { folders: [folder], reason }, commit), /unavailable/);
});

test('cancellation or changed symlink during approval prevents a late grant', async t => {
  const { root, folder, session } = await setup(t);
  session.activeClient.request = async () => { session.capabilityGeneration = 1; return approved; };
  await assert.rejects(requestFolderAccess(session, { folders: [folder], reason }, () => assert.fail('late grant')), /cancelled/);
  session.activeClient.request = async () => { await fs.mkdir(path.dirname(folder), { recursive: true }); await fs.symlink(root, folder); return approved; };
  await assert.rejects(requestFolderAccess(session, { folders: [folder], reason }, () => assert.fail('retargeted grant')), /changed/);
});

test('previously approved folders do not prompt or restart; grants are isolated by session', async t => {
  const { folder, session } = await setup(t);
  session.writableFolders = [folder];
  session.activeClient.request = () => assert.fail('duplicate approval');
  assert.equal((await requestFolderAccess(session, { folders: [folder], reason }, () => assert.fail('duplicate grant'))).restartRequired, false);
  const other = { ...session, writableFolders: [], activeClient: { request: async () => ({ outcome: { outcome: 'cancelled' } }) } };
  await assert.rejects(requestFolderAccess(other, { folders: [folder], reason }, () => assert.fail('cross-session grant')), /not approved/);
});

test('broker dispatches folder requests without starting any MCP server', async () => {
  const session = { id: 'one' }, request = { sessionId: 'one', action: 'request_write', folders: ['~/.docker/buildx'], reason };
  const broker = new CapabilityBroker({ sessions: new Map([['one', session]]), requestFolderAccess: async (actual, args) => {
    assert.equal(actual, session); assert.equal(args, request); return 'approved';
  } });
  broker.clientFor = () => assert.fail('MCP server started');
  assert.equal(await broker.handle(request), 'approved');
});

test('bridge persists scoped grants and resumes original task once with updated sandbox input', async t => {
  const { root, folder, session } = await setup(t);
  const bridge = new UnrealAgentBridge({ dataDir: path.join(root, 'data') });
  t.after(() => bridge.close());
  bridge.sessions.set(session.id, session);
  session.provider = 'offline-fixture'; session.model = 'test'; session.mcpServers = [];
  session.activeTurn = null;
  const launches = [];
  const client = { request: async () => approved, notify: async () => {} };
  bridge.runPrompt = async (current, input, activeClient, turn) => {
    launches.push({ input, folders: [...current.writableFolders] });
    turn.liveInput = false;
    current.activeClient = activeClient;
    if (launches.length === 1) {
      assert.equal(input, 'build and configure app');
      turn.activeToolCalls.add('request-tool');
      await bridge.capabilityBroker.handle({ sessionId: session.id, action: 'request_write', folders: [folder], reason });
      assert.equal(turn.interruptRequested, true);
      assert.equal(turn.activeToolCalls.size, 1); // approval does not kill active tools
      turn.activeToolCalls.clear();
      return { stopReason: 'steered' };
    }
    assert.ok(input[0].includes('Continue the original task'));
    return { stopReason: 'end_turn' };
  };
  const result = await bridge.prompt({ sessionId: session.id, prompt: [{ type: 'text', text: 'build and configure app' }] }, client);
  assert.equal(result.stopReason, 'end_turn'); assert.equal(launches.length, 2);
  assert.deepEqual(launches.map(value => value.folders), [[], [folder]]);
  assert.deepEqual(session.pendingInputs, []);
  const stored = JSON.parse(await fs.readFile(bridge.sessionMetadataPath(session.id), 'utf8'));
  assert.deepEqual(stored.writableFolders, [folder]);
  await bridge.resumeSession({ sessionId: session.id, cwd: root });
  assert.deepEqual(bridge.sessions.get(session.id).writableFolders, [folder]);
});

test('sandbox includes only exact approved subpaths in Workspace, never Read-only', { skip: process.platform !== 'darwin' }, async t => {
  const { root, folder } = await setup(t);
  const launch = mode => sandboxLaunch({ mode, runner: '/bin/echo', args: [], cwd: root, dataDir: path.join(root, 'data'), writableFolders: [folder] });
  assert.ok((await launch('workspace-write')).profile.includes(`(subpath "${folder}")`));
  assert.ok(!(await launch('read-only')).profile.includes(folder));
  await fs.mkdir(path.dirname(folder), { recursive: true }); await fs.symlink(root, folder);
  await assert.rejects(launch('workspace-write'), /changed/);
});

test('failed grant persistence rolls back folders and cannot schedule a restart', async t => {
  const { root, folder, session } = await setup(t);
  const bridge = new UnrealAgentBridge({ dataDir: path.join(root, 'data') });
  t.after(() => bridge.close());
  session.pendingInputs = [];
  bridge.persistSession = async () => { throw new Error('disk full'); };
  await assert.rejects(bridge.requestFolderAccess(session, { folders: [folder], reason }), /disk full/);
  assert.deepEqual(session.writableFolders, []);
  assert.deepEqual(session.pendingInputs, []);
  assert.equal(session.activeTurn.folderRestart, undefined);
  assert.equal(session.pendingFolderRequest, false);
});

test('request-write CLI passes folders and reason through the capability socket, including stdin JSON', async t => {
  const { root } = await setup(t);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const broker = new CapabilityBroker({ socketPath: path.join(root, 'cli.sock'), sessions: new Map([['cli', { id: 'cli' }]]),
    requestFolderAccess: async (_session, args) => ({ folders: args.folders, reason: args.reason }) });
  t.after(() => broker.close());
  await broker.start();
  // fileURLToPath is required for project folders with spaces.
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../bin/unreal-capability.mjs', import.meta.url));
  const args = { folders: ['~/.docker/buildx', '~/Library/Application Support/Ochsner Kaneo'], reason };
  const env = { ...process.env, UNREAL_AGENT_CAPABILITY_SOCKET: broker.socketPath, UNREAL_AGENT_SESSION_ID: 'cli' };
  const result = await promisify(execFile)(process.execPath, [cli, 'request-write', JSON.stringify(args)], { env });
  assert.deepEqual(JSON.parse(result.stdout), args);
  const stdinResult = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [cli, 'request-write'], { env }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify(args));
  });
  assert.deepEqual(JSON.parse(stdinResult), args);
});
