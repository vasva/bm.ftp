const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const posix = path.posix;
const { LoopbackSftpServer } = require('./sftp/loopback-server.cjs');

let activePanel;
let provider;
let trustPrompts = [];
let folderAnswer;
let warningAnswers = [];
let warningPrompts = [];
let warningStarted;
let clipboardText;

const vscodeMock = {
  EventEmitter: class { event() { return { dispose() {} }; } fire() {} dispose() {} },
  ViewColumn: { One: 1 }, StatusBarAlignment: { Right: 2 },
  Uri: {
    joinPath(base, ...parts) { return { fsPath: path.join(base.fsPath, ...parts), toString() { return this.fsPath; } }; },
    file(fsPath) { return { fsPath, scheme: 'file' }; }, from(value) { return { ...value }; }
  },
  Disposable: { from(...items) { return { dispose() { for (const item of items) item?.dispose?.(); } }; } },
  window: {
    activeTextEditor: undefined,
    createStatusBarItem() { return { show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }; },
    onDidChangeActiveTextEditor() { return { dispose() {} }; },
    createWebviewPanel() { return activePanel; },
    async showWarningMessage(...args) {
      warningPrompts.push(args);
      const index = warningPrompts.length - 1;
      warningStarted?.();
      const answer = warningAnswers[index];
      return typeof answer === 'function' ? answer(args) : answer;
    },
    async showInputBox() { const answer = folderAnswer; folderAnswer = undefined; return answer; },
    async showTextDocument(document) { return document; },
    async openTextDocument(uri) { return uri; },
    async showInformationMessage() {}
  },
  workspace: {
    get workspaceFolders() { return activePanel ? [{ uri: { fsPath: activePanel.workspaceRoot } }] : []; },
    getWorkspaceFolder(uri) {
      if (!activePanel) return undefined;
      const rel = path.relative(activePanel.workspaceRoot, uri.fsPath);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
        ? { uri: { fsPath: activePanel.workspaceRoot } } : undefined;
    },
    registerTextDocumentContentProvider(_scheme, value) { provider = value; return { dispose() {} }; },
    onDidCloseTextDocument() { return { dispose() {} }; },
    async openTextDocument(uri) {
      if (uri.scheme === 'bm-ftp-readonly') return { uri, getText: () => provider.provideTextDocumentContent(uri) };
      return { uri };
    },
    async findFiles() { return []; },
    fs: { async delete(uri, options) { await fs.rm(uri.fsPath, { recursive: options?.recursive ?? false }); } }
  },
  env: { clipboard: { async writeText(value) { clipboardText = value; } } }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const { CommanderPanel } = require('../out/commanderPanel.js');
Module._load = originalLoad;

async function createHost(t, server) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-sftp-host-'));
  activePanel = {
    workspaceRoot,
    webview: {
      html: '', cspSource: 'vscode-webview:',
      asWebviewUri(uri) { return uri; },
      onDidReceiveMessage(listener) { this.receive = listener; return { dispose() {} }; },
      async postMessage(message) { this.messages.push(message); for (const listener of [...this.messageListeners]) listener(message); return true; },
      messages: [], messageListeners: new Set()
    },
    onDidDispose(listener) { this.disposeListener = listener; return { dispose() {} }; },
    reveal() {}
  };
  const secrets = new Map();
  const state = new Map();
  const context = {
    extensionUri: { fsPath: path.resolve(__dirname, '..') }, extensionPath: path.resolve(__dirname, '..'),
    globalStorageUri: { fsPath: path.join(workspaceRoot, 'storage') }, subscriptions: [],
    globalState: { get(key) { return state.get(key); }, async update(key, value) { state.set(key, value); } },
    secrets: { async get(key) { return secrets.get(key); }, async store(key, value) { secrets.set(key, value); } }
  };
  warningAnswers = [];
  warningPrompts = [];
  warningStarted = undefined;
  trustPrompts = [];
  folderAnswer = undefined;
  clipboardText = undefined;
  const readonly = CommanderPanel.registerReadonlyDocuments();
  CommanderPanel.close();
  CommanderPanel.createOrShow(context);
  const host = CommanderPanel.current;
  host.localPath = workspaceRoot;
  t.after(async () => {
    activePanel.disposeListener?.();
    readonly.dispose();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });
  return { host, workspaceRoot, secrets, state, context, server };
}

function profile(server, extra = {}) {
  return { host: '127.0.0.1', port: server.port, username: server.username, protocol: 'sftp', ...extra };
}

function waitForMessage(webview, predicate) {
  const existing = webview.messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const listener = (message) => {
      if (!predicate(message)) return;
      webview.messageListeners.delete(listener);
      resolve(message);
    };
    webview.messageListeners.add(listener);
  });
}

async function startFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-sftp-remote-'));
  const server = await new LoopbackSftpServer({ root, ...options }).start();
  t.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  return server;
}

test('real SFTP host rejects an untrusted key before auth, then browses home, views, mkdirs, and copies exact trees', async (t) => {
  const server = await startFixture(t);
  await fs.mkdir(server.diskPath('/home/tester/remote-tree/empty'), { recursive: true });
  await fs.mkdir(server.diskPath('/home/tester/remote-tree/nested'), { recursive: true });
  const sourceBytes = Buffer.from([0, 1, 2, 0, 254, 255]);
  await fs.writeFile(server.diskPath('/home/tester/remote-tree/nested/data.bin'), sourceBytes);
  await fs.writeFile(server.diskPath('/home/tester/remote-tree/zero.dat'), Buffer.alloc(0));
  await fs.writeFile(server.diskPath('/home/tester/remote-tree/readme.txt'), 'line one\nline two\n');
  await fs.writeFile(server.diskPath('/home/tester/sibling-remote.bin'), Buffer.from([7, 0, 8]));
  await fs.writeFile(server.diskPath('/home/tester/unrelated.txt'), 'keep remote');
  await fs.symlink('remote-tree', server.diskPath('/home/tester/link'));

  const { host, workspaceRoot, secrets } = await createHost(t, server);
  const connectProfile = profile(server);
  warningAnswers.push(undefined);
  await assert.rejects(host.connect(connectProfile, server.password), /host key was not trusted/);
  assert.equal(server.passwordAuthAttempts, 0, 'host-key cancellation must happen before password authentication');
  assert.equal([...secrets.keys()].some((key) => key.includes('hostkey')), false);

  warningAnswers.push('Trust key and connect');
  await host.connect(connectProfile, server.password);
  assert.equal(host.connected, true);
  assert.equal(host.remotePath, '/home/tester');
  assert.equal(server.passwordAuthAttempts, 1);
  assert.match(String(warningPrompts[1][0]), /SHA256:/);
  assert.equal([...secrets.keys()].filter((key) => key.includes('hostkey')).length, 1);

  await host.navigate('remote', '/home/tester/remote-tree/nested');
  await host.openFile('remote', '/home/tester/remote-tree/nested/data.bin');
  await host.navigate('remote', '/home/tester');
  folderAnswer = 'created';
  await host.createFolder('remote');
  assert.equal((await fs.stat(server.diskPath('/home/tester/created'))).isDirectory(), true);

  const upload = path.join(workspaceRoot, 'upload.bin');
  await fs.writeFile(upload, sourceBytes);
  await host.copy('local', [upload]);
  assert.deepEqual(await fs.readFile(server.diskPath('/home/tester/upload.bin')), sourceBytes);
  await host.copyPath('remote', '/home/tester/upload.bin', false);
  assert.equal(clipboardText, `sftp://127.0.0.1:${server.port}/home/tester/upload.bin`);

  const localTree = path.join(workspaceRoot, 'local-tree');
  await fs.mkdir(path.join(localTree, 'empty'), { recursive: true });
  await fs.mkdir(path.join(localTree, 'nested'), { recursive: true });
  await fs.writeFile(path.join(localTree, 'nested', 'bytes.bin'), sourceBytes);
  await fs.writeFile(path.join(localTree, 'zero'), Buffer.alloc(0));
  const siblingLocal = path.join(workspaceRoot, 'sibling-local.bin');
  await fs.writeFile(siblingLocal, Buffer.from([6, 0, 5]));
  await host.copy('local', [localTree, siblingLocal]);
  assert.deepEqual(await fs.readFile(server.diskPath('/home/tester/local-tree/nested/bytes.bin')), sourceBytes);
  assert.deepEqual(await fs.readFile(server.diskPath('/home/tester/sibling-local.bin')), Buffer.from([6, 0, 5]));
  assert.equal((await fs.stat(server.diskPath('/home/tester/local-tree/empty'))).isDirectory(), true);
  assert.equal((await fs.stat(server.diskPath('/home/tester/local-tree/zero'))).size, 0);

  await fs.writeFile(path.join(workspaceRoot, 'unrelated.txt'), 'keep local');
  await host.copy('remote', ['/home/tester/remote-tree', '/home/tester/sibling-remote.bin']);
  assert.deepEqual(await fs.readFile(path.join(workspaceRoot, 'remote-tree/nested/data.bin')), sourceBytes);
  assert.deepEqual(await fs.readFile(path.join(workspaceRoot, 'sibling-remote.bin')), Buffer.from([7, 0, 8]));
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'unrelated.txt'), 'utf8'), 'keep local');
  assert.equal(await fs.readFile(server.diskPath('/home/tester/unrelated.txt'), 'utf8'), 'keep remote');
  assert.equal((await fs.stat(path.join(workspaceRoot, 'remote-tree/empty'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(workspaceRoot, 'remote-tree/zero.dat'))).size, 0);
  const progress = activePanel.webview.messages.filter((message) => message.type === 'copy-progress');
  assert.ok(progress.some((message) => message.progress?.transferred === sourceBytes.length + 3 && message.progress?.total === sourceBytes.length + 3 && message.progress?.totalItems === 6));
  assert.equal(progress.at(-1).progress, null);

  const bridge = { endpoint: 'loopback', token: 'test-only', dispose() {} };
  host.agentBridge = bridge;
  host.agentRoot = '/home/tester';
  host.agentSessionId = 'sftp-agent-session';
  const agentListing = await host.handleAgentRequest({ method: 'list_directory', params: { sessionId: 'sftp-agent-session', path: '/remote-tree' } });
  assert.equal(agentListing.path, '/remote-tree');
  assert.ok(agentListing.entries.some((entry) => entry.path === '/remote-tree/readme.txt'));
  const agentFile = await host.handleAgentRequest({ method: 'read_file', params: { sessionId: 'sftp-agent-session', path: '/remote-tree/readme.txt' } });
  assert.equal(agentFile.text, 'line one\nline two\n');
  assert.throws(() => host.resolveAgentPath('/../../etc/passwd'), /outside the granted/);
  await assert.rejects(host.scanRemoteSelection(['/home/tester/link']), /symbolic link/);
  assert.equal(server.shellRequests + server.execRequests + server.forwardRequests + server.ptyRequests, 0);
  const connectionLost = waitForMessage(activePanel.webview, (message) => message.type === 'data' && message.connected === false && /connection lost/i.test(message.transfer ?? ''));
  for (const client of server.clients) client.end();
  await connectionLost;
  assert.equal(host.connected, false);
});

test('SFTP mkdir denial is recoverable and replacement cancellation/acceptance preserves exact bytes and staging cleanup', async (t) => {
  const server = await startFixture(t);
  const { host, workspaceRoot, secrets } = await createHost(t, server);
  warningAnswers.push('Trust key and connect');
  await host.connect(profile(server), server.password);
  const deniedPath = '/home/tester/denied';
  server.failMkdir.add(deniedPath);
  folderAnswer = 'denied';
  await assert.rejects(host.createFolder('remote'));
  assert.equal(host.connected, true, 'a permission denial is not a dropped SSH session');
  assert.equal((await fs.readdir(server.diskPath('/home/tester'))).includes('denied'), false);

  const remoteTarget = '/home/tester/replace.bin';
  const oldRemote = Buffer.from([9, 8, 0, 7]);
  const nextRemote = Buffer.from([0, 4, 5, 0, 6]);
  await fs.writeFile(server.diskPath(remoteTarget), oldRemote);
  const upload = path.join(workspaceRoot, 'replace.bin');
  await fs.writeFile(upload, nextRemote);
  warningAnswers.push(undefined);
  await host.copy('local', [upload]);
  assert.deepEqual(await fs.readFile(server.diskPath(remoteTarget)), oldRemote);
  assert.equal(warningPrompts.at(-1)[2], 'Replace');

  warningAnswers.push('Replace');
  await host.copy('local', [upload]);
  assert.deepEqual(await fs.readFile(server.diskPath(remoteTarget)), nextRemote);
  assert.equal((await server.tree('/home/tester')).some((entry) => entry.path.includes('.bmftp-')), false);

  const localTarget = path.join(workspaceRoot, 'download.bin');
  const oldLocal = Buffer.from([1, 2, 3]);
  await fs.writeFile(localTarget, oldLocal);
  await fs.writeFile(server.diskPath('/home/tester/download.bin'), nextRemote);
  warningAnswers.push(undefined);
  await host.copy('remote', ['/home/tester/download.bin']);
  assert.deepEqual(await fs.readFile(localTarget), oldLocal);

  warningAnswers.push('Replace');
  await host.copy('remote', ['/home/tester/download.bin']);
  assert.deepEqual(await fs.readFile(localTarget), nextRemote);
  assert.equal((await fs.readdir(workspaceRoot)).some((name) => name.startsWith('.bmftp-')), false);

  const previousRemote = await fs.readFile(server.diskPath(remoteTarget));
  server.sizeAdjustment = 1;
  warningAnswers.push('Replace');
  await assert.rejects(host.copy('local', [upload]), /Upload validation failed/);
  assert.deepEqual(await fs.readFile(server.diskPath(remoteTarget)), previousRemote);
  assert.equal((await server.tree('/home/tester')).some((entry) => entry.path.includes('.bmftp-')), false);
  server.sizeAdjustment = 0;

  const incompleteDownload = Buffer.from([0, 3, 4, 5, 6]);
  await fs.writeFile(server.diskPath('/home/tester/download.bin'), incompleteDownload);
  server.shortRead.add('/home/tester/download.bin');
  warningAnswers.push('Replace');
  await assert.rejects(host.copy('remote', ['/home/tester/download.bin']), /Download validation failed/);
  assert.deepEqual(await fs.readFile(localTarget), nextRemote);
  assert.equal((await fs.readdir(workspaceRoot)).some((name) => name.startsWith('.bmftp-')), false);
  server.shortRead.clear();
  assert.equal(host.connected, true, 'transfer/size failures must leave a healthy connection usable');
  await host.client.close();
});

test('wrong SFTP password does not pin a host key and a later trusted retry connects', async (t) => {
  const server = await startFixture(t);
  const { host, secrets } = await createHost(t, server);
  warningAnswers.push('Trust key and connect');
  await assert.rejects(host.connect(profile(server), 'wrong-password'));
  assert.equal([...secrets.keys()].some((key) => key.includes('hostkey')), false);
  assert.equal(host.connected, false);
  warningAnswers.push('Trust key and connect');
  await host.connect(profile(server), server.password);
  assert.equal(host.connected, true);
  assert.equal([...secrets.keys()].filter((key) => key.includes('hostkey')).length, 1);
  await host.client.close();
});

test('changed SFTP host key cancellation keeps the old pin and does not authenticate', async (t) => {
  const firstServer = await startFixture(t);
  const { host, secrets } = await createHost(t, firstServer);
  warningAnswers.push('Trust key and connect');
  await host.connect(profile(firstServer), firstServer.password);
  const pinEntry = [...secrets.entries()].find(([key]) => key.includes('hostkey'));
  assert.ok(pinEntry);
  const authBefore = firstServer.passwordAuthAttempts;
  const oldPath = firstServer.root;
  await host.client.close();
  await firstServer.close();

  // Restart the fixture on the same endpoint with a different key where supported.
  const changedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-sftp-changed-'));
  const changedServer = await new LoopbackSftpServer({ root: changedRoot, port: firstServer.port }).start();
  t.after(async () => { await changedServer.close(); await fs.rm(changedRoot, { recursive: true, force: true }); });
  const oldServerPort = firstServer.port;
  assert.equal(changedServer.port, oldServerPort);
  warningAnswers.push('Cancel');
  await assert.rejects(host.connect(profile(changedServer), changedServer.password), /host key was not trusted/);
  assert.equal(changedServer.passwordAuthAttempts, 0);
  assert.equal(secrets.get(pinEntry[0]), pinEntry[1]);
  assert.match(String(warningPrompts.at(-1)[0]), /has changed/);
  assert.ok(String(warningPrompts.at(-1)[0]).includes(JSON.parse(pinEntry[1]).fingerprint));
  assert.notEqual(oldPath, changedServer.root);
});

test('closing during an SFTP trust prompt invalidates the approval and prevents auth or pinning', async (t) => {
  const server = await startFixture(t);
  const { host, secrets } = await createHost(t, server);
  let releasePrompt;
  let promptReady;
  const started = new Promise((resolve) => { promptReady = resolve; });
  warningStarted = () => promptReady();
  warningAnswers.push(() => new Promise((resolve) => { releasePrompt = resolve; }));
  const pending = host.connect(profile(server), server.password);
  await started;
  host.client.close();
  releasePrompt('Trust key and connect');
  await assert.rejects(pending, /no longer current|cancelled|closed during setup/);
  assert.equal(server.passwordAuthAttempts, 0);
  assert.equal([...secrets.keys()].some((key) => key.includes('hostkey')), false);
  assert.equal(host.connected, false);
});
