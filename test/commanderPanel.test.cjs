const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const originalLoad = Module._load;
const clients = [];
let contentProvider;
let workspaceRoot;
let nextWarning = 'Replace';
let warningCalls;
let localDeleteCalls;
let deleteFailurePath;
let localDeleteGate;
let localDeleteStarted;
let warningStarted;
let openDocumentContent;
let secretsGate;
let secretsStarted;
let folderPrompt;
let folderPromptStarted;
let clipboardText;

class FakeClient {
  constructor() {
    this.isClosed = true;
    this.accessCount = 0;
    this.activeLists = 0;
    this.maxActiveLists = 0;
    this.entries = new Map([['/', []]]);
    this.remoteFiles = new Map();
    this.sizeAdjustment = 0;
    this.progressHandler = undefined;
    this.operations = [];
    this.noopFailure = false;
    this.noopCalls = 0;
    this.noopGate = undefined;
    this.noopStarted = undefined;
    this.accessGate = undefined;
    this.accessStarted = undefined;
    this.listGate = undefined;
    this.downloadFailure = false;
    this.uploadFailure = false;
    clients.push(this);
  }

  get closed() { return this.isClosed; }
  close() { this.isClosed = true; this.operations.push('close'); }
  async sendIgnoringError(command) {
    this.operations.push(command);
    if (command === 'NOOP') {
      this.noopCalls += 1;
      this.noopStarted?.();
      if (this.noopGate) await this.noopGate;
      if (this.noopFailure) {
        this.isClosed = true;
        throw new Error('simulated connection loss');
      }
    }
    return { code: 200 };
  }

  async access(options) {
    this.accessCount += 1;
    this.operations.push(`access:${options.protocol ?? (options.secure ? 'ftps' : 'ftp')}`);
    this.accessStarted?.();
    if (this.accessGate) await this.accessGate;
    this.isClosed = false;
  }

  async list(directory) {
    this.activeLists += 1;
    this.maxActiveLists = Math.max(this.maxActiveLists, this.activeLists);
    this.operations.push(`list:${directory}`);
    try {
      if (this.listGate) await this.listGate;
      return this.entries.get(directory) ?? [];
    } finally {
      this.activeLists -= 1;
    }
  }

  async uploadFrom(localPath, remotePath) {
    this.operations.push(`upload:${remotePath}`);
    this.remoteFiles.set(remotePath, 'partial');
    if (this.uploadFailure) throw new Error('simulated interrupted upload');
    const content = await fs.readFile(localPath, 'utf8');
    this.remoteFiles.set(remotePath, content);
    this.progressHandler?.({ name: remotePath, type: 'upload', bytes: Math.floor(Buffer.byteLength(content) / 2), bytesOverall: 0 });
    this.progressHandler?.({ name: remotePath, type: 'upload', bytes: Buffer.byteLength(content), bytesOverall: Buffer.byteLength(content) });
  }

  async downloadTo(destination, remotePath) {
    this.operations.push(`download:${remotePath}`);
    const value = this.remoteFiles.get(remotePath) ?? 'remote content';
    if (typeof destination === 'string') {
      await fs.writeFile(destination, this.downloadFailure ? 'partial' : value);
      this.progressHandler?.({ name: remotePath, type: 'download', bytes: Buffer.byteLength(value) / 2, bytesOverall: 0 });
      this.progressHandler?.({ name: remotePath, type: 'download', bytes: Buffer.byteLength(value), bytesOverall: Buffer.byteLength(value) });
      if (this.downloadFailure) throw new Error('simulated interrupted download');
    } else {
      destination.end(value);
    }
  }

  async rename(from, to) {
    if (!this.remoteFiles.has(from)) throw new Error(`Missing remote path ${from}`);
    this.remoteFiles.set(to, this.remoteFiles.get(from));
    this.remoteFiles.delete(from);
    const sourceParent = path.posix.dirname(from);
    const sourceName = path.posix.basename(from);
    this.entries.set(sourceParent, (this.entries.get(sourceParent) ?? []).filter((entry) => entry.name !== sourceName));
    const parent = path.posix.dirname(to);
    const name = path.posix.basename(to);
    const entries = this.entries.get(parent) ?? [];
    this.entries.set(parent, [...entries.filter((entry) => entry.name !== name), { name, size: Buffer.byteLength(this.remoteFiles.get(to)), isFile: true, isDirectory: false, isSymbolicLink: false }]);
  }

  async remove(remotePath) {
    this.operations.push(`remove:${remotePath}`);
    if (deleteFailurePath === remotePath) throw new Error('simulated delete failure');
    this.remoteFiles.delete(remotePath);
    const parent = path.posix.dirname(remotePath);
    const name = path.posix.basename(remotePath);
    this.entries.set(parent, (this.entries.get(parent) ?? []).filter((entry) => entry.name !== name));
  }
  trackProgress(handler) { this.progressHandler = handler; }
  async size(remotePath) {
    const content = this.remoteFiles.get(remotePath);
    return (content === undefined ? 0 : Buffer.byteLength(content)) + this.sizeAdjustment;
  }
  async removeDir(remotePath) {
    this.operations.push(`removeDir:${remotePath}`);
    if (deleteFailurePath === remotePath) throw new Error('simulated delete failure');
    for (const candidate of [...this.remoteFiles.keys()]) {
      if (candidate === remotePath || candidate.startsWith(`${remotePath}/`)) this.remoteFiles.delete(candidate);
    }
    for (const candidate of [...this.entries.keys()]) {
      if (candidate === remotePath || candidate.startsWith(`${remotePath}/`)) this.entries.delete(candidate);
    }
    const parent = path.posix.dirname(remotePath);
    const name = path.posix.basename(remotePath);
    this.entries.set(parent, (this.entries.get(parent) ?? []).filter((entry) => entry.name !== name));
  }
  async ensureDir(directory) {
    let current = '/';
    for (const segment of directory.split('/').filter(Boolean)) {
      const next = path.posix.join(current, segment);
      if (!this.entries.has(next)) {
        this.entries.set(next, []);
        const parentEntries = this.entries.get(current) ?? [];
        if (!parentEntries.some((entry) => entry.name === segment)) {
          this.entries.set(current, [...parentEntries, { name: segment, size: 0, isFile: false, isDirectory: true, isSymbolicLink: false }]);
        }
      }
      current = next;
    }
  }
  async cd() {}
}

const vscodeMock = {
  EventEmitter: class {
    listeners = [];
    event = (listener) => { this.listeners.push(listener); return { dispose() {} }; };
    fire() { for (const listener of this.listeners) listener(); }
    dispose() { this.listeners = []; }
  },
  ViewColumn: { One: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: {
    joinPath(base, ...parts) { return { fsPath: path.join(base.fsPath, ...parts) }; },
    from(value) { return { ...value }; },
    file(fsPath) { return { fsPath, scheme: 'file' }; }
  },
  Disposable: {
    from(...items) { return { dispose() { for (const item of items) item?.dispose?.(); } }; }
  },
  window: {
    activeTextEditor: undefined,
    createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
    onDidChangeActiveTextEditor() { return { dispose() {} }; },
    async showWarningMessage(...args) { warningCalls.push(args); warningStarted?.(); return nextWarning; },
    async showInformationMessage() {},
    async showInputBox() { folderPromptStarted?.(); return folderPrompt; },
    async showTextDocument(document) { return document; }
  },
  workspace: {
    get workspaceFolders() { return workspaceRoot ? [{ uri: { fsPath: workspaceRoot } }] : []; },
    getWorkspaceFolder(uri) {
      if (!workspaceRoot) return undefined;
      const relative = path.relative(workspaceRoot, uri.fsPath);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        ? { uri: { fsPath: workspaceRoot } }
        : undefined;
    },
    fs: {
      async delete(uri, options) {
        localDeleteCalls.push({ path: uri.fsPath, options });
        localDeleteStarted?.(uri.fsPath);
        if (localDeleteGate) await localDeleteGate;
        if (deleteFailurePath === uri.fsPath) throw new Error('simulated delete failure');
        await fs.rm(uri.fsPath, { recursive: options?.recursive ?? false, force: false });
      }
    },
    registerTextDocumentContentProvider(_scheme, provider) { contentProvider = provider; return { dispose() {} }; },
    onDidCloseTextDocument() { return { dispose() {} }; },
    async openTextDocument(uri) {
      if (uri.scheme === 'bm-ftp-readonly') {
        openDocumentContent = await contentProvider.provideTextDocumentContent(uri);
        return { uri, getText: () => openDocumentContent };
      }
      return { uri };
    }
  },
  env: { clipboard: { async writeText(value) { clipboardText = value; } } }
};

Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  if (request === 'basic-ftp') return { Client: FakeClient };
  return originalLoad.call(this, request, parent, isMain);
};
const { CommanderPanel } = require('../out/commanderPanel.js');
Module._load = originalLoad;

async function createPanel(t) {
  clients.length = 0;
  contentProvider = undefined;
  openDocumentContent = undefined;
  nextWarning = 'Replace';
  warningCalls = [];
  localDeleteCalls = [];
  deleteFailurePath = undefined;
  localDeleteGate = undefined;
  localDeleteStarted = undefined;
  warningStarted = undefined;
  secretsGate = undefined;
  secretsStarted = undefined;
  folderPrompt = undefined;
  folderPromptStarted = undefined;
  clipboardText = undefined;
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-ftp-host-'));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const messages = [];
  let receive;
  let dispose;
  const panel = {
    webview: {
      html: '', cspSource: 'vscode-webview:',
      asWebviewUri(uri) { return uri; },
      onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; },
      async postMessage(message) { messages.push(message); return true; }
    },
    onDidDispose(listener) { dispose = listener; return { dispose() {} }; },
    reveal() {}
  };
  const context = {
    extensionUri: { fsPath: workspaceRoot },
    extensionPath: path.resolve(__dirname, '..'),
    globalStorageUri: { fsPath: path.join(workspaceRoot, 'global-storage') },
    subscriptions: [],
    globalState: { get() { return undefined; }, async update() {} },
    secrets: { async get() { secretsStarted?.(); if (secretsGate) await secretsGate; return 'test-password'; }, async store() {} }
  };
  CommanderPanel.registerReadonlyDocuments();
  const instance = new CommanderPanel(panel, context);
  t.after(() => dispose?.());
  async function send(message) {
    receive(message);
    await instance.operationQueue.enqueue(async () => undefined);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { instance, client: clients.at(-1), messages, send, warningCalls, localDeleteCalls, dispose: () => dispose?.() };
}

test('host serializes FTP listing requests from overlapping webview messages', async (t) => {
  const host = await createPanel(t);
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });
  let releaseList;
  const gate = new Promise((resolve) => { releaseList = resolve; });
  host.client.listGate = gate;
  host.send({ type: 'refresh' });
  while (host.client.activeLists === 0) await new Promise((resolve) => setImmediate(resolve));
  host.send({ type: 'navigate', pane: 'remote', path: '/next' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.client.maxActiveLists, 1);
  releaseList();
  await new Promise((resolve) => setTimeout(resolve, 10));
  host.client.listGate = undefined;
  await host.instance.operationQueue.enqueue(async () => undefined);
  assert.equal(host.client.maxActiveLists, 1);
});

test('pane refresh only sends the requested local or FTP listing', async (t) => {
  const host = await createPanel(t);
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  host.messages.length = 0;
  await host.send({ type: 'refresh', pane: 'local' });
  assert.equal(host.messages.some((message) => message.localEntries !== undefined), true);
  assert.equal(host.messages.some((message) => message.remoteEntries !== undefined), false);
  assert.equal(host.client.operations.filter((operation) => operation.startsWith('list:')).length, 1);

  host.messages.length = 0;
  const previousRemoteListings = host.client.operations.filter((operation) => operation.startsWith('list:')).length;
  await host.send({ type: 'refresh', pane: 'remote' });
  assert.equal(host.messages.some((message) => message.remoteEntries !== undefined), true);
  assert.equal(host.messages.some((message) => message.localEntries !== undefined), false);
  assert.equal(host.client.operations.filter((operation) => operation.startsWith('list:')).length, previousRemoteListings + 1);
});

test('connection monitor sends serialized keepalives and marks a failed FTP session offline', async (t) => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  let timer;
  global.setInterval = (callback, delay) => {
    assert.equal(delay, 60_000);
    timer = { callback, active: true };
    return timer;
  };
  global.clearInterval = (value) => {
    if (value === timer) timer.active = false;
    else originalClearInterval(value);
  };
  t.after(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  });

  const host = await createPanel(t);
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });
  assert.equal(timer.active, true);
  let releaseNoop;
  let markNoopStarted;
  const noopStarted = new Promise((resolve) => { markNoopStarted = resolve; });
  host.client.noopStarted = markNoopStarted;
  host.client.noopGate = new Promise((resolve) => { releaseNoop = resolve; });
  timer.callback();
  await noopStarted;
  timer.callback();
  assert.equal(host.client.noopCalls, 1);
  releaseNoop();
  await host.instance.operationQueue.enqueue(async () => undefined);
  assert.equal(host.client.noopCalls, 1);
  assert.equal(host.instance.connected, true);
  host.client.noopStarted = undefined;
  host.client.noopGate = undefined;

  host.client.noopFailure = true;
  timer.callback();
  await host.instance.operationQueue.enqueue(async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.instance.connected, false);
  assert.equal(timer.active, false);
  assert.equal(host.messages.at(-1).connected, false);
  assert.match(host.messages.at(-1).transfer, /connection lost/i);
});

test('disposing a panel prevents a pending connect from reopening its FTP client', async (t) => {
  const host = await createPanel(t);
  let resolveAccess;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  host.client.accessStarted = markStarted;
  host.client.accessGate = new Promise((resolve) => { resolveAccess = resolve; });
  host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });
  await started;
  host.dispose();
  host.send({ type: 'connect', profile: { host: 'other.example', username: 'u' }, password: 'p' });
  resolveAccess();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.client.accessCount, 1);
  assert.equal(host.client.closed, true);
  assert.equal(host.instance.connected, false);
});

test('disposing while SecretStorage is pending prevents a later connection attempt', async (t) => {
  const host = await createPanel(t);
  let resolveSecrets;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  secretsStarted = markStarted;
  secretsGate = new Promise((resolve) => { resolveSecrets = resolve; });
  host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' } });
  await started;
  host.dispose();
  resolveSecrets();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.client.accessCount, 0);
  assert.equal(host.client.closed, true);
});

test('disposing while the folder prompt is open prevents folder creation', async (t) => {
  const host = await createPanel(t);
  let resolvePrompt;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  folderPromptStarted = markStarted;
  folderPrompt = new Promise((resolve) => { resolvePrompt = resolve; });
  host.send({ type: 'create-folder', pane: 'local' });
  await started;
  host.dispose();
  resolvePrompt('created-after-close');
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(fs.access(path.join(workspaceRoot, 'created-after-close')), { code: 'ENOENT' });
});

test('remote view fetches read-only content without deadlocking the serialized host', async (t) => {
  const host = await createPanel(t);
  host.client.entries.set('/', [{ name: 'readme.txt', size: 14, isFile: true, isDirectory: false }]);
  host.client.remoteFiles.set('/readme.txt', 'remote content');
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });
  await host.send({ type: 'open-file', pane: 'remote', path: '/readme.txt' });
  assert.equal(openDocumentContent, 'remote content');
  assert.equal(host.client.closed, false);
  assert.equal(host.instance.connected, true);
});

test('failed replacement download keeps the original local file intact', async (t) => {
  const host = await createPanel(t);
  const target = path.join(workspaceRoot, 'report.txt');
  await fs.writeFile(target, 'original local content');
  host.client.entries.set('/', [{ name: 'report.txt', size: 7, isFile: true, isDirectory: false }]);
  host.client.remoteFiles.set('/report.txt', 'replacement');
  host.client.downloadFailure = true;
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });
  await host.send({ type: 'copy', source: 'remote', path: '/report.txt' });
  assert.equal(await fs.readFile(target, 'utf8'), 'original local content');
  assert.deepEqual((await fs.readdir(workspaceRoot)).sort(), ['report.txt']);
});

test('host rejects stale local paths and copies selected remote directories', async (t) => {
  const host = await createPanel(t);
  await fs.writeFile(path.join(workspaceRoot, 'local.txt'), 'local');
  host.client.entries.set('/', [{ name: 'folder', size: 0, isFile: false, isDirectory: true }]);
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });
  await host.send({ type: 'copy', source: 'local', path: path.join(os.tmpdir(), 'stale.txt') });
  await host.send({ type: 'copy', source: 'remote', path: '/folder' });
  assert.equal(host.client.operations.some((operation) => operation.startsWith('upload:')), false);
  assert.equal(host.client.operations.some((operation) => operation.startsWith('download:')), false);
  assert.equal((await fs.stat(path.join(workspaceRoot, 'folder'))).isDirectory(), true);
  assert.ok(host.messages.some((message) => message.type === 'error'));
});

test('copies absolute and workspace-relative local paths to the clipboard', async (t) => {
  const host = await createPanel(t);
  const target = path.join(workspaceRoot, 'folder name.txt');
  await fs.writeFile(target, 'content');

  await host.send({ type: 'copy-path', pane: 'local', path: target });
  assert.equal(clipboardText, target);

  await host.send({ type: 'copy-path', pane: 'local', path: target, relative: true });
  assert.equal(clipboardText, `${path.sep}folder name.txt`);
  assert.ok(host.messages.some((message) => message.transfer === 'Path copied.'));
  assert.ok(host.messages.some((message) => message.transfer === 'Relative path copied.'));
});

test('FTP Copy Path writes the full credential-free FTPS URL and rejects relative paths', async (t) => {
  const host = await createPanel(t);
  host.client.entries.set('/', [{ name: 'folder name.txt', size: 3, isFile: true, isDirectory: false }]);
  await host.send({ type: 'connect', profile: { host: 'ftp.example', port: 2121, username: 'user', protocol: 'ftps' }, password: 'secret' });

  await host.send({ type: 'copy-path', pane: 'remote', path: '/folder name.txt' });
  assert.equal(clipboardText, 'ftps://ftp.example:2121/folder%20name.txt');

  await host.send({ type: 'copy-path', pane: 'remote', path: '/folder name.txt', relative: true });
  assert.ok(host.messages.some((message) => message.type === 'error' && message.operation === 'copy-path'));
  assert.equal(clipboardText, 'ftps://ftp.example:2121/folder%20name.txt');
});

test('FTP Copy Path preserves literal escapes and encodes special characters and IPv6 hosts', async (t) => {
  const host = await createPanel(t);
  const name = 'literal%20 name#? café.txt';
  host.client.entries.set('/', [{ name, size: 3, isFile: true, isDirectory: false }]);
  await host.send({ type: 'connect', profile: { host: '::1', port: 2121, username: 'user', protocol: 'ftps' }, password: 'secret' });

  await host.send({ type: 'copy-path', pane: 'remote', path: `/${name}` });
  assert.equal(clipboardText, 'ftps://[::1]:2121/literal%2520%20name%23%3F%20caf%C3%A9.txt');
  assert.equal(decodeURIComponent(new URL(clipboardText).pathname), `/${name}`);
});

test('FTP downloads reject case and Unicode normalization collisions on case-insensitive filesystems', {
  skip: process.platform !== 'darwin' && process.platform !== 'win32'
}, async (t) => {
  const host = await createPanel(t);
  const entries = ['Résumé.txt', 'Re\u0301sume\u0301.txt'].map((name) => ({ name, size: 1, isFile: true, isDirectory: false }));
  host.client.entries.set('/', entries);
  host.client.remoteFiles.set('/Résumé.txt', 'a');
  host.client.remoteFiles.set('/Re\u0301sume\u0301.txt', 'b');
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  await host.send({ type: 'copy', source: 'remote', paths: ['/Résumé.txt', '/Re\u0301sume\u0301.txt'] });

  assert.equal(host.client.operations.some((operation) => operation.startsWith('download:')), false);
  assert.ok(host.messages.some((message) => message.type === 'error' && /overwrite each other/i.test(message.error)));
  assert.deepEqual(await fs.readdir(workspaceRoot), []);
});

test('host MCP access enforces granted-root, session, sensitive-file, binary, and revocation policies', async (t) => {
  const host = await createPanel(t);
  host.client.entries.set('/', [{ name: 'safe', size: 0, isFile: false, isDirectory: true }]);
  host.client.entries.set('/safe', [
    { name: 'notes.txt', size: 4, isFile: true, isDirectory: false },
    { name: '.env', size: 5, isFile: true, isDirectory: false },
    { name: 'binary.bin', size: 2, isFile: true, isDirectory: false },
    { name: 'bad-encoding.txt', size: 1, isFile: true, isDirectory: false }
  ]);
  host.client.remoteFiles.set('/safe/notes.txt', 'text');
  host.client.remoteFiles.set('/safe/.env', 'token');
  host.client.remoteFiles.set('/safe/binary.bin', Buffer.from([0, 1]));
  host.client.remoteFiles.set('/safe/bad-encoding.txt', Buffer.from([0xff]));
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });
  CommanderPanel.current = host.instance;
  const sessionId = host.instance.agentSessionId;
  await host.instance.grantAgentAccess('/safe', sessionId);
  const request = (method, params = {}) => host.instance.handleAgentRequest({ method, params });

  const listing = await request('list_directory', { sessionId, path: '/' });
  assert.deepEqual(listing.entries.map((entry) => entry.path), ['/.env', '/bad-encoding.txt', '/binary.bin', '/notes.txt']);
  assert.equal((await request('read_file', { sessionId, path: '/notes.txt' })).text, 'text');
  await assert.rejects(request('list_directory', { sessionId, path: '/../private' }), /outside the granted FTP root/i);
  await assert.rejects(request('list_directory', { sessionId: 'stale-session', path: '/' }), /session changed/i);
  await assert.rejects(request('read_file', { sessionId, path: '/.env' }), /blocked/i);
  await assert.rejects(request('read_file', { sessionId, path: '/binary.bin' }), /binary files/i);
  await assert.rejects(request('read_file', { sessionId, path: '/bad-encoding.txt' }), /valid utf-8/i);

  host.instance.revokeAgentAccess();
  await assert.rejects(request('list_directory', { sessionId, path: '/' }), /revoked/i);
});

test('local-to-FTP copy reports transfer and validation progress before completing', async (t) => {
  const host = await createPanel(t);
  const source = path.join(workspaceRoot, 'report.txt');
  const content = 'hello transfer';
  await fs.writeFile(source, content);
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  await host.send({ type: 'copy', source: 'local', path: source });

  const progress = host.messages.filter((message) => message.type === 'copy-progress').map((message) => message.progress);
  assert.equal(host.client.remoteFiles.get('/report.txt'), content);
  assert.equal(progress[0].direction, 'upload');
  assert.equal(progress[0].total, Buffer.byteLength(content));
  assert.ok(progress.some((item) => item.phase === 'transfer' && item.transferred > 0));
  assert.ok(progress.some((item) => item.phase === 'verify' && item.verified === Buffer.byteLength(content)));
  assert.equal(progress.at(-1), null);
});

test('FTP-to-local copy reports progress and validates downloaded size before replacing the file', async (t) => {
  const host = await createPanel(t);
  const content = 'remote transfer';
  host.client.entries.set('/', [{ name: 'remote.txt', size: Buffer.byteLength(content), isFile: true, isDirectory: false }]);
  host.client.remoteFiles.set('/remote.txt', content);
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  await host.send({ type: 'copy', source: 'remote', path: '/remote.txt' });

  assert.equal(await fs.readFile(path.join(workspaceRoot, 'remote.txt'), 'utf8'), content);
  const progress = host.messages.filter((message) => message.type === 'copy-progress').map((message) => message.progress);
  assert.equal(progress[0].direction, 'download');
  assert.equal(progress[0].total, Buffer.byteLength(content));
  assert.ok(progress.some((item) => item.phase === 'verify' && item.verified === Buffer.byteLength(content)));
  assert.equal(progress.at(-1), null);
});

test('upload size validation failure preserves the existing remote file', async (t) => {
  const host = await createPanel(t);
  const source = path.join(workspaceRoot, 'report.txt');
  await fs.writeFile(source, 'new content');
  host.client.entries.set('/', [{ name: 'report.txt', size: 3, isFile: true, isDirectory: false }]);
  host.client.remoteFiles.set('/report.txt', 'old');
  host.client.sizeAdjustment = 1;
  nextWarning = 'Replace';
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  await host.send({ type: 'copy', source: 'local', path: source });

  assert.equal(host.client.remoteFiles.get('/report.txt'), 'old');
  assert.ok(host.messages.some((message) => message.type === 'error' && /Upload validation failed/.test(message.error)));
  assert.equal(host.client.progressHandler, undefined);
});

test('download size validation failure preserves the existing local file', async (t) => {
  const host = await createPanel(t);
  const target = path.join(workspaceRoot, 'remote.txt');
  await fs.writeFile(target, 'local original');
  host.client.entries.set('/', [{ name: 'remote.txt', size: 15, isFile: true, isDirectory: false }]);
  host.client.remoteFiles.set('/remote.txt', 'short');
  nextWarning = 'Replace';
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  await host.send({ type: 'copy', source: 'remote', path: '/remote.txt' });

  assert.equal(await fs.readFile(target, 'utf8'), 'local original');
  assert.ok(host.messages.some((message) => message.type === 'error' && /Download validation failed/.test(message.error)));
  assert.equal(host.client.progressHandler, undefined);
});

test('multi-selection uploads files and nested folders recursively and merges destination folders', async (t) => {
  const host = await createPanel(t);
  await fs.writeFile(path.join(workspaceRoot, 'root.txt'), 'root file');
  await fs.mkdir(path.join(workspaceRoot, 'bundle', 'nested'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'bundle', 'one.txt'), 'first');
  await fs.writeFile(path.join(workspaceRoot, 'bundle', 'nested', 'two.txt'), 'second');
  host.client.entries.set('/', [{ name: 'bundle', size: 0, isFile: false, isDirectory: true, isSymbolicLink: false }]);
  host.client.entries.set('/bundle', [
    { name: 'nested', size: 0, isFile: false, isDirectory: true, isSymbolicLink: false },
    { name: 'one.txt', size: 3, isFile: true, isDirectory: false, isSymbolicLink: false }
  ]);
  host.client.entries.set('/bundle/nested', []);
  host.client.remoteFiles.set('/bundle/one.txt', 'old');
  nextWarning = 'Replace';
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  await host.send({ type: 'copy', source: 'local', paths: [path.join(workspaceRoot, 'root.txt'), path.join(workspaceRoot, 'bundle')] });

  assert.equal(host.client.remoteFiles.get('/root.txt'), 'root file');
  assert.equal(host.client.remoteFiles.get('/bundle/one.txt'), 'first');
  assert.equal(host.client.remoteFiles.get('/bundle/nested/two.txt'), 'second');
  assert.equal(host.client.remoteFiles.get('/bundle/one.txt'), 'first');
  assert.match(host.warningCalls[0][0], /Replace 1 existing file/);
  const progress = host.messages.filter((message) => message.type === 'copy-progress').map((message) => message.progress).filter(Boolean).at(-1);
  assert.equal(progress.totalItems, 5);
  assert.equal(progress.copiedItems, 5);
  assert.equal(progress.verifiedItems, 5);
});

test('multi-selection downloads remote folders recursively and asks once before file replacements', async (t) => {
  const host = await createPanel(t);
  await fs.mkdir(path.join(workspaceRoot, 'bundle', 'nested'), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, 'bundle', 'nested', 'one.txt'), 'local old');
  const remoteEntries = new Map([
    ['/', [
      { name: 'bundle', size: 0, isFile: false, isDirectory: true, isSymbolicLink: false },
      { name: 'top.txt', size: 3, isFile: true, isDirectory: false, isSymbolicLink: false }
    ]],
    ['/bundle', [{ name: 'nested', size: 0, isFile: false, isDirectory: true, isSymbolicLink: false }]],
    ['/bundle/nested', [
      { name: 'one.txt', size: 5, isFile: true, isDirectory: false, isSymbolicLink: false },
      { name: 'two.txt', size: 6, isFile: true, isDirectory: false, isSymbolicLink: false }
    ]]
  ]);
  for (const [directory, entries] of remoteEntries) host.client.entries.set(directory, entries);
  host.client.remoteFiles.set('/top.txt', 'top');
  host.client.remoteFiles.set('/bundle/nested/one.txt', 'first');
  host.client.remoteFiles.set('/bundle/nested/two.txt', 'second');
  nextWarning = 'Replace';
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  await host.send({ type: 'copy', source: 'remote', paths: ['/bundle', '/top.txt'] });

  assert.equal(await fs.readFile(path.join(workspaceRoot, 'bundle', 'nested', 'one.txt'), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'bundle', 'nested', 'two.txt'), 'utf8'), 'second');
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'top.txt'), 'utf8'), 'top');
  assert.match(host.warningCalls[0][0], /Replace 1 existing file/);
  const progress = host.messages.filter((message) => message.type === 'copy-progress').map((message) => message.progress).filter(Boolean).at(-1);
  assert.equal(progress.totalItems, 5);
  assert.equal(progress.copiedItems, 5);
  assert.equal(progress.verifiedItems, 5);
});

test('local deletion confirms a batch, moves files and folders to Trash, and removes folder contents', async (t) => {
  const host = await createPanel(t);
  const file = path.join(workspaceRoot, 'notes.txt');
  const folder = path.join(workspaceRoot, 'folder');
  await fs.writeFile(file, 'notes');
  await fs.mkdir(path.join(folder, 'nested'), { recursive: true });
  await fs.writeFile(path.join(folder, 'nested', 'data.txt'), 'data');
  nextWarning = 'Delete';

  await host.send({ type: 'delete', pane: 'local', paths: [file, folder] });

  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  await assert.rejects(fs.access(folder), { code: 'ENOENT' });
  assert.deepEqual(host.localDeleteCalls.map((call) => call.options), [
    { recursive: false, useTrash: true },
    { recursive: true, useTrash: true }
  ]);
  assert.match(host.warningCalls[0][0], /Delete 2 selected items from local folder/);
  assert.match(host.warningCalls[0][0], /notes\.txt/);
  assert.match(host.warningCalls[0][0], /folder\//);
  assert.equal(host.warningCalls[0][1].modal, true);
  assert.equal(host.warningCalls[0][2], 'Delete');
  assert.ok(host.messages.some((message) => message.transfer === 'Deleted 2 items from local folder.'));
});

test('cancelling the local delete confirmation leaves every selected item intact', async (t) => {
  const host = await createPanel(t);
  const file = path.join(workspaceRoot, 'keep.txt');
  await fs.writeFile(file, 'keep');
  nextWarning = undefined;

  await host.send({ type: 'delete', pane: 'local', paths: [file] });

  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  assert.deepEqual(host.localDeleteCalls, []);
  assert.ok(host.messages.some((message) => message.transfer === 'Deletion cancelled.'));
});

test('local deletion validates the whole batch before prompting or deleting', async (t) => {
  const host = await createPanel(t);
  const file = path.join(workspaceRoot, 'keep.txt');
  await fs.writeFile(file, 'keep');

  await host.send({ type: 'delete', pane: 'local', paths: [file, path.join(workspaceRoot, '..', 'outside.txt')] });

  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  assert.deepEqual(host.localDeleteCalls, []);
  assert.deepEqual(host.warningCalls, []);
  assert.ok(host.messages.some((message) => message.type === 'error' && /directly inside/.test(message.error)));
});

test('deleting a local folder symlink unlinks it without traversing its external target', async (t) => {
  const host = await createPanel(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-ftp-outside-'));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  const outsideFile = path.join(external, 'keep.txt');
  const link = path.join(workspaceRoot, 'external-folder');
  await fs.writeFile(outsideFile, 'safe');
  try {
    await fs.symlink(external, link, 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Symlinks are unavailable on this filesystem.');
    throw error;
  }
  nextWarning = 'Delete';

  await host.send({ type: 'delete', pane: 'local', paths: [link] });

  await assert.rejects(fs.lstat(link), { code: 'ENOENT' });
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'safe');
  assert.deepEqual(host.localDeleteCalls[0].options, { recursive: false, useTrash: true });
});

test('FTP deletion confirms and removes files and folders recursively', async (t) => {
  const host = await createPanel(t);
  host.client.entries.set('/', [
    { name: 'notes.txt', size: 5, isFile: true, isDirectory: false, isSymbolicLink: false },
    { name: 'folder', size: 0, isFile: false, isDirectory: true, isSymbolicLink: false }
  ]);
  host.client.entries.set('/folder', [
    { name: 'nested.txt', size: 4, isFile: true, isDirectory: false, isSymbolicLink: false }
  ]);
  host.client.remoteFiles.set('/notes.txt', 'notes');
  host.client.remoteFiles.set('/folder/nested.txt', 'data');
  nextWarning = 'Delete';
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  await host.send({ type: 'delete', pane: 'remote', paths: ['/notes.txt', '/folder'] });

  assert.ok(host.client.operations.includes('remove:/notes.txt'));
  assert.ok(host.client.operations.includes('removeDir:/folder'));
  assert.equal(host.client.remoteFiles.has('/notes.txt'), false);
  assert.equal(host.client.remoteFiles.has('/folder/nested.txt'), false);
  assert.match(host.warningCalls[0][0], /FTP folders and all their contents will be permanently deleted/);
  assert.ok(host.messages.some((message) => message.transfer === 'Deleted 2 items from FTP folder.'));
});

test('FTP directory symlinks use file removal instead of recursive directory deletion', async (t) => {
  const host = await createPanel(t);
  host.client.entries.set('/', [
    { name: 'link', size: 0, isFile: false, isDirectory: true, isSymbolicLink: true }
  ]);
  nextWarning = 'Delete';
  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });

  await host.send({ type: 'delete', pane: 'remote', paths: ['/link'] });

  assert.ok(host.client.operations.includes('remove:/link'));
  assert.equal(host.client.operations.includes('removeDir:/link'), false);
});

test('FTP deletion rejects disconnected, root, stale, and outside selections', async (t) => {
  const host = await createPanel(t);
  await host.send({ type: 'delete', pane: 'remote', paths: ['/file.txt'] });
  assert.ok(host.messages.some((message) => message.type === 'error' && /Connect to an FTP server/.test(message.error)));
  assert.deepEqual(host.warningCalls, []);

  await host.send({ type: 'connect', profile: { host: 'ftp.example', username: 'u' }, password: 'p' });
  await host.send({ type: 'delete', pane: 'remote', paths: ['/'] });
  await host.send({ type: 'delete', pane: 'remote', paths: ['/parent/file.txt'] });
  assert.deepEqual(host.warningCalls, []);
  assert.equal(host.client.operations.some((operation) => operation.startsWith('remove')), false);
});

test('duplicate delete paths are confirmed and deleted once', async (t) => {
  const host = await createPanel(t);
  const file = path.join(workspaceRoot, 'once.txt');
  await fs.writeFile(file, 'one');
  nextWarning = 'Delete';

  await host.send({ type: 'delete', pane: 'local', paths: [file, file] });

  assert.equal(host.warningCalls.length, 1);
  assert.equal(host.localDeleteCalls.length, 1);
});

test('a partial local batch failure reports completed items and refreshes the listing', async (t) => {
  const host = await createPanel(t);
  const first = path.join(workspaceRoot, 'first.txt');
  const second = path.join(workspaceRoot, 'second.txt');
  await fs.writeFile(first, '1');
  await fs.writeFile(second, '2');
  deleteFailurePath = second;
  nextWarning = 'Delete';

  await host.send({ type: 'delete', pane: 'local', paths: [first, second] });

  await assert.rejects(fs.access(first), { code: 'ENOENT' });
  assert.equal(await fs.readFile(second, 'utf8'), '2');
  const error = host.messages.find((message) => message.type === 'error' && message.error.includes('Deleted 1 of 2'));
  assert.ok(error);
  const latestLocalListing = host.messages.filter((message) => message.localEntries).at(-1);
  assert.deepEqual(latestLocalListing.localEntries.map((entry) => entry.name), ['second.txt']);
});

test('disposing while delete confirmation is open prevents the deletion', async (t) => {
  const host = await createPanel(t);
  const file = path.join(workspaceRoot, 'keep.txt');
  await fs.writeFile(file, 'keep');
  let resolveWarning;
  let markPrompted;
  const prompted = new Promise((resolve) => { markPrompted = resolve; });
  nextWarning = new Promise((resolve) => { resolveWarning = resolve; });
  warningStarted = markPrompted;
  const sending = host.send({ type: 'delete', pane: 'local', paths: [file] });
  await prompted;
  host.dispose();
  resolveWarning('Delete');
  await sending;

  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
  assert.deepEqual(host.localDeleteCalls, []);
});

test('disposing after the first local delete prevents later items in the batch', async (t) => {
  const host = await createPanel(t);
  const first = path.join(workspaceRoot, 'first.txt');
  const second = path.join(workspaceRoot, 'second.txt');
  await fs.writeFile(first, 'first');
  await fs.writeFile(second, 'second');
  let releaseDelete;
  let markDeleteStarted;
  const deleteStarted = new Promise((resolve) => { markDeleteStarted = resolve; });
  localDeleteStarted = markDeleteStarted;
  localDeleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  nextWarning = 'Delete';

  const sending = host.send({ type: 'delete', pane: 'local', paths: [first, second] });
  await deleteStarted;
  host.dispose();
  releaseDelete();
  await sending;

  await assert.rejects(fs.access(first), { code: 'ENOENT' });
  assert.equal(await fs.readFile(second, 'utf8'), 'second');
  assert.deepEqual(host.localDeleteCalls.map((call) => call.path), [first]);
});
