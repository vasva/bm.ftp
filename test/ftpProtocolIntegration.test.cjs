const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReadOnlyFtpServer } = require('./ftp/loopback-server.cjs');

let activePanel;
let textProvider;
let openedText;
let warningResponse;
let warningCalls;
let folderResponse;
let folderCalls;

const vscodeMock = {
  EventEmitter: class {
    listeners = [];
    event = (listener) => { this.listeners.push(listener); return { dispose() {} }; };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners = []; }
  },
  ViewColumn: { One: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: {
    joinPath(base, ...parts) {
      const fsPath = path.join(base.fsPath, ...parts);
      return { fsPath, toString: () => `file://${fsPath}` };
    },
    from(value) { return { ...value }; },
    file(fsPath) { return { fsPath, scheme: 'file' }; }
  },
  Disposable: {
    from(...items) { return { dispose() { for (const item of items) item?.dispose?.(); } }; }
  },
  window: {
    activeTextEditor: undefined,
    createStatusBarItem() { return { text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }; },
    onDidChangeActiveTextEditor() { return { dispose() {} }; },
    createWebviewPanel() { return activePanel; },
    async showWarningMessage(...args) { warningCalls.push(args); return warningResponse; },
    async showInformationMessage() {},
    async showInputBox(...args) { folderCalls.push(args); return folderResponse; },
    async openTextDocument(uri) { return uri; },
    async showTextDocument(document) { return document; }
  },
  workspace: {
    get workspaceFolders() { return activePanel ? [{ uri: { fsPath: activePanel.workspaceRoot } }] : []; },
    getWorkspaceFolder(uri) {
      if (!activePanel) return undefined;
      const relative = path.relative(activePanel.workspaceRoot, uri.fsPath);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
        ? { uri: { fsPath: activePanel.workspaceRoot } }
        : undefined;
    },
    registerTextDocumentContentProvider(_scheme, provider) {
      textProvider = provider;
      return { dispose() { textProvider = undefined; } };
    },
    onDidCloseTextDocument() { return { dispose() {} }; },
    async openTextDocument(uri) {
      if (uri.scheme === 'bm-ftp-readonly') {
        const content = await textProvider.provideTextDocumentContent(uri);
        openedText = content;
        return { uri, getText: () => content };
      }
      return { uri };
    },
    async findFiles() { return []; }
  },
  env: { clipboard: { async writeText() {} } }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const { CommanderPanel } = require('../out/commanderPanel.js');
Module._load = originalLoad;

async function createHost(t, port) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-ftp-protocol-'));
  activePanel = {
    workspaceRoot,
    webview: {
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri(uri) { return uri; },
      onDidReceiveMessage(listener) { this.receive = listener; return { dispose() {} }; },
      async postMessage(message) { this.messages.push(message); return true; },
      messages: []
    },
    onDidDispose(listener) { this.disposeListener = listener; return { dispose() {} }; },
    reveal() {}
  };
  const panel = activePanel;
  const context = {
    extensionUri: { fsPath: path.resolve(__dirname, '..') },
    extensionPath: path.resolve(__dirname, '..'),
    globalStorageUri: { fsPath: path.join(workspaceRoot, 'storage') },
    subscriptions: [],
    globalState: { get() { return undefined; }, async update() {} },
    secrets: { async get() { return undefined; }, async store() {} }
  };
  textProvider = undefined;
  openedText = undefined;
  warningResponse = undefined;
  warningCalls = [];
  folderResponse = undefined;
  folderCalls = [];
  const readonlyProvider = CommanderPanel.registerReadonlyDocuments();
  t.after(() => readonlyProvider.dispose());
  CommanderPanel.createOrShow(context);
  const instance = CommanderPanel.current;

  t.after(async () => {
    panel.disposeListener?.();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    if (activePanel === panel) activePanel = undefined;
  });

  async function send(message) {
    panel.webview.receive(message);
    await instance.operationQueue.enqueue(async () => undefined);
  }

  return {
    panel, instance, send, port,
    get messages() { return panel.webview.messages; },
    get warningCalls() { return warningCalls; },
    get folderCalls() { return folderCalls; },
    setWarningResponse(value) { warningResponse = value; },
    setFolderResponse(value) { folderResponse = value; }
  };
}

function profile(port, password = 'correct-password') {
  return {
    type: 'connect',
    profile: { host: '127.0.0.1', port, username: 'tester', protocol: 'ftp' },
    password
  };
}

function assertNoWriteCommands(server) {
  const writes = server.commands.filter(({ command }) => ['STOR', 'APPE', 'DELE', 'MKD', 'RMD', 'RNFR', 'RNTO'].includes(command));
  assert.deepEqual(writes, []);
}

async function createWritableFixture(t, options = {}) {
  const server = new ReadOnlyFtpServer({ writable: true, ...options });
  const port = await server.listen();
  t.after(() => server.close());
  const host = await createHost(t, port);
  await host.send(profile(port));
  assert.equal(host.instance.connected, true);
  return { server, host, port };
}

function copyProgress(host) {
  return host.messages
    .filter((message) => message.type === 'copy-progress')
    .map((message) => message.progress);
}

function assertNoRemoteStaging(server) {
  assert.deepEqual([...server.files.keys()].filter((file) => /\.bmftp-.*\.(?:uploading|backup)$/.test(file)), []);
}

async function assertNoLocalStaging(root) {
  const pending = [root];
  const staging = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (/^\.bmftp-.*\.part$/.test(entry.name)) staging.push(entryPath);
      else if (entry.isDirectory()) pending.push(entryPath);
    }
  }
  assert.deepEqual(staging, []);
}

test('real basic-ftp client connects, lists, navigates, reads a file, and disconnects against loopback', async (t) => {
  const server = new ReadOnlyFtpServer();
  const port = await server.listen();
  t.after(() => server.close());
  const host = await createHost(t, port);

  await host.send(profile(port));
  assert.equal(host.instance.connected, true);
  let data = host.messages.filter((message) => message.remoteEntries !== undefined).at(-1);
  assert.equal(data.connected, true);
  assert.deepEqual(data.remoteEntries.map((entry) => [entry.name, entry.kind]), [
    ['docs', 'directory'], ['welcome.txt', 'file']
  ]);

  await host.send({ type: 'navigate', pane: 'remote', path: '/docs' });
  data = host.messages.filter((message) => message.remotePath === '/docs' && message.remoteEntries !== undefined).at(-1);
  assert.deepEqual(data.remoteEntries.map((entry) => entry.path), ['/docs/readme.txt']);

  await host.send({ type: 'open-file', pane: 'remote', path: '/docs/readme.txt' });
  assert.equal(openedText, 'read-only nested file');
  assert.equal(host.instance.connected, true);
  assert.ok(server.commands.some(({ command, argument }) => command === 'RETR' && argument === '/docs/readme.txt'));

  await host.send({ type: 'disconnect' });
  assert.equal(host.instance.connected, false);
  assertNoWriteCommands(server);
});

test('a rejected FTP login reports an error and the same panel can retry successfully', async (t) => {
  const server = new ReadOnlyFtpServer();
  const port = await server.listen();
  t.after(() => server.close());
  const host = await createHost(t, port);

  await host.send(profile(port, 'wrong-password'));
  assert.equal(host.instance.connected, false);
  assert.ok(host.messages.some((message) => message.type === 'error' && message.operation === 'connect' && /530|Login/i.test(message.error)));

  await host.send(profile(port));
  assert.equal(host.instance.connected, true);
  assert.ok(host.messages.some((message) => message.remoteEntries?.some((entry) => entry.name === 'welcome.txt')));
  assertNoWriteCommands(server);
});

test('a denied FTP folder listing leaves the connection usable for the next refresh', async (t) => {
  const server = new ReadOnlyFtpServer({ failListingPaths: ['/blocked'] });
  const port = await server.listen();
  t.after(() => server.close());
  const host = await createHost(t, port);

  await host.send(profile(port));
  await host.send({ type: 'navigate', pane: 'remote', path: '/blocked' });
  assert.ok(host.messages.some((message) => message.type === 'error' && message.operation === 'navigate' && /550|Listing unavailable/i.test(message.error)));
  assert.equal(host.instance.connected, true);
  assert.equal(host.instance.remotePath, '/');

  await host.send({ type: 'refresh', pane: 'remote' });
  const latest = host.messages.filter((message) => message.remoteEntries !== undefined).at(-1);
  assert.equal(latest.connected, true);
  assert.deepEqual(latest.remoteEntries.map((entry) => entry.name), ['docs', 'welcome.txt']);
  assertNoWriteCommands(server);
});

test('FTP mkdir creates the requested directory and a denied mkdir reports an error', async (t) => {
  const { server, host } = await createWritableFixture(t, { denyMkdirPaths: ['/denied'] });
  host.setFolderResponse('created');
  await host.send({ type: 'create-folder', pane: 'remote' });
  assert.equal(server.directories.has('/created'), true);
  assert.ok(server.commands.some(({ command, argument }) => command === 'MKD' && argument === 'created'));
  assert.ok(host.messages.some((message) => message.transfer === 'Created folder created.'));

  host.setFolderResponse('denied');
  await host.send({ type: 'create-folder', pane: 'remote' });
  assert.equal(server.directories.has('/denied'), false);
  assert.ok(host.messages.some((message) => message.type === 'error' && message.operation === 'create-folder' && /550|Directory creation denied/i.test(message.error)));
});

test('single-file upload and download preserve exact bytes and report completed progress', async (t) => {
  const content = Buffer.from([0x00, 0x41, 0xff, 0x0a, 0x42]);
  const { server, host } = await createWritableFixture(t, { files: { '/download.bin': content } });
  const localUpload = path.join(host.panel.workspaceRoot, 'upload.bin');
  await fs.writeFile(localUpload, content);

  await host.send({ type: 'copy', source: 'local', paths: [localUpload] });
  assert.deepEqual(server.files.get('/upload.bin'), content);
  let progress = copyProgress(host);
  assert.equal(progress[0].direction, 'upload');
  assert.equal(progress[0].total, content.length);
  assert.equal(progress.filter(Boolean).at(-1).copiedItems, 1);
  assert.equal(progress.filter(Boolean).at(-1).verifiedItems, 1);
  assert.equal(progress.at(-1), null);

  const downloadProgressStart = copyProgress(host).length;
  await host.send({ type: 'copy', source: 'remote', paths: ['/download.bin'] });
  assert.deepEqual(await fs.readFile(path.join(host.panel.workspaceRoot, 'download.bin')), content);
  progress = copyProgress(host).slice(downloadProgressStart);
  assert.equal(progress[0].direction, 'download');
  assert.equal(progress[0].total, content.length);
  assert.equal(progress.filter(Boolean).at(-1).copiedItems, 1);
  assert.equal(progress.filter(Boolean).at(-1).verifiedItems, 1);
  assert.equal(progress.at(-1), null);
  assertNoRemoteStaging(server);
  await assertNoLocalStaging(host.panel.workspaceRoot);
});

test('mixed recursive upload preserves nested files, empty folders, zero-byte files, and item totals', async (t) => {
  const { server, host } = await createWritableFixture(t);
  const root = path.join(host.panel.workspaceRoot, 'bundle');
  await fs.mkdir(path.join(root, 'deep'), { recursive: true });
  await fs.mkdir(path.join(root, 'empty'), { recursive: true });
  const topBytes = Buffer.from('top-level');
  await fs.writeFile(path.join(root, 'top.txt'), topBytes);
  await fs.writeFile(path.join(root, 'deep', 'zero.bin'), Buffer.alloc(0));

  await host.send({ type: 'copy', source: 'local', paths: [root] });

  assert.equal(server.directories.has('/bundle'), true);
  assert.equal(server.directories.has('/bundle/deep'), true);
  assert.equal(server.directories.has('/bundle/empty'), true);
  assert.deepEqual([...server.directories].sort(), ['/', '/bundle', '/bundle/deep', '/bundle/empty', '/docs']);
  assert.deepEqual(server.files.get('/bundle/top.txt'), topBytes);
  assert.deepEqual(server.files.get('/bundle/deep/zero.bin'), Buffer.alloc(0));
  assert.deepEqual([...server.files.keys()].filter((file) => file.startsWith('/bundle/')).sort(), [
    '/bundle/deep/zero.bin', '/bundle/top.txt'
  ]);
  assert.equal(server.files.has('/bundle/empty/placeholder'), false);
  const completed = copyProgress(host).filter(Boolean).at(-1);
  assert.equal(completed.total, topBytes.length);
  assert.equal(completed.totalItems, 5);
  assert.equal(completed.copiedItems, 5);
  assert.equal(completed.verifiedItems, 5);
  assert.equal(copyProgress(host).at(-1), null);
  assertNoRemoteStaging(server);
});

test('mixed recursive download preserves nested files, empty folders, zero-byte files, and item totals', async (t) => {
  const files = {
    '/bundle/top.txt': Buffer.from('remote top'),
    '/bundle/deep/zero.bin': Buffer.alloc(0)
  };
  const directories = ['/bundle', '/bundle/deep', '/bundle/empty'];
  const { server, host } = await createWritableFixture(t, { files, directories });

  await host.send({ type: 'copy', source: 'remote', paths: ['/bundle'] });

  const root = path.join(host.panel.workspaceRoot, 'bundle');
  assert.deepEqual((await fs.readdir(host.panel.workspaceRoot)).sort(), ['bundle']);
  assert.deepEqual((await fs.readdir(root)).sort(), ['deep', 'empty', 'top.txt']);
  assert.deepEqual((await fs.readdir(path.join(root, 'deep'))).sort(), ['zero.bin']);
  assert.deepEqual(await fs.readFile(path.join(root, 'top.txt')), files['/bundle/top.txt']);
  assert.deepEqual(await fs.readFile(path.join(root, 'deep', 'zero.bin')), Buffer.alloc(0));
  assert.equal((await fs.stat(path.join(root, 'empty'))).isDirectory(), true);
  const completed = copyProgress(host).filter(Boolean).at(-1);
  assert.equal(completed.total, Buffer.byteLength('remote top'));
  assert.equal(completed.totalItems, 5);
  assert.equal(completed.copiedItems, 5);
  assert.equal(completed.verifiedItems, 5);
  assert.equal(copyProgress(host).at(-1), null);
  await assertNoLocalStaging(host.panel.workspaceRoot);
  assertNoRemoteStaging(server);
});

test('accepted FTP replacement atomically swaps bytes and removes staging and backup files', async (t) => {
  const original = Buffer.from('old remote bytes');
  const replacement = Buffer.from([0, 2, 0xff, 3]);
  const { server, host } = await createWritableFixture(t, { files: { '/report.bin': original } });
  const local = path.join(host.panel.workspaceRoot, 'report.bin');
  await fs.writeFile(local, replacement);
  host.setWarningResponse('Replace');

  await host.send({ type: 'copy', source: 'local', paths: [local] });

  assert.deepEqual(server.files.get('/report.bin'), replacement);
  assert.equal(host.warningCalls.length, 1);
  assert.equal(host.warningCalls[0][1].modal, true);
  assert.match(host.warningCalls[0][0], /Replace 1 existing file/);
  assertNoRemoteStaging(server);
  const completed = copyProgress(host).filter(Boolean).at(-1);
  assert.equal(completed.total, replacement.length);
  assert.equal(completed.totalItems, 1);
  assert.equal(completed.copiedItems, 1);
  assert.equal(completed.verifiedItems, 1);
  assert.ok(host.messages.some((message) => message.transfer === 'Copied 1 item to FTP.'));
});

test('cancelled FTP replacement leaves original remote bytes unchanged and uploads no staging file', async (t) => {
  const original = Buffer.from('preserve remote bytes');
  const { server, host } = await createWritableFixture(t, { files: { '/report.bin': original } });
  const local = path.join(host.panel.workspaceRoot, 'report.bin');
  await fs.writeFile(local, Buffer.from('replacement bytes'));

  await host.send({ type: 'copy', source: 'local', paths: [local] });

  assert.deepEqual(server.files.get('/report.bin'), original);
  assert.equal(server.commands.some(({ command }) => command === 'STOR'), false);
  assertNoRemoteStaging(server);
  assert.equal(copyProgress(host).some(Boolean), false);
  assert.equal(copyProgress(host).at(-1), null);
  assert.ok(host.messages.some((message) => message.transfer === 'Copy cancelled.'));
});

test('accepted local replacement atomically downloads exact bytes without leaving a part file', async (t) => {
  const remote = Buffer.from('new local bytes');
  const { host } = await createWritableFixture(t, { files: { '/report.bin': remote } });
  const local = path.join(host.panel.workspaceRoot, 'report.bin');
  await fs.writeFile(local, Buffer.from('old local bytes'));
  host.setWarningResponse('Replace');

  await host.send({ type: 'copy', source: 'remote', paths: ['/report.bin'] });

  assert.deepEqual(await fs.readFile(local), remote);
  assert.match(host.warningCalls[0][0], /Replace 1 existing file/);
  await assertNoLocalStaging(host.panel.workspaceRoot);
  const completed = copyProgress(host).filter(Boolean).at(-1);
  assert.equal(completed.total, remote.length);
  assert.equal(completed.totalItems, 1);
  assert.equal(completed.copiedItems, 1);
  assert.equal(completed.verifiedItems, 1);
  assert.equal(copyProgress(host).at(-1), null);
});

test('cancelled local replacement preserves original bytes and creates no part file', async (t) => {
  const original = Buffer.from('original local bytes');
  const { server, host } = await createWritableFixture(t, { files: { '/report.bin': Buffer.from('remote replacement') } });
  const local = path.join(host.panel.workspaceRoot, 'report.bin');
  await fs.writeFile(local, original);

  await host.send({ type: 'copy', source: 'remote', paths: ['/report.bin'] });

  assert.deepEqual(await fs.readFile(local), original);
  assert.equal(server.commands.some(({ command, argument }) => command === 'RETR' && argument === '/report.bin'), false);
  await assertNoLocalStaging(host.panel.workspaceRoot);
  assert.equal(copyProgress(host).some(Boolean), false);
  assert.ok(host.messages.some((message) => message.transfer === 'Copy cancelled.'));
});

test('upload and download size mismatches report copy errors and clean all staging files', async (t) => {
  const { server, host } = await createWritableFixture(t, {
    files: { '/report.bin': Buffer.from('preserved') }, defaultSizeAdjustment: 1
  });
  const local = path.join(host.panel.workspaceRoot, 'report.bin');
  await fs.writeFile(local, Buffer.from('new payload'));
  host.setWarningResponse('Replace');

  await host.send({ type: 'copy', source: 'local', paths: [local] });
  assert.deepEqual(server.files.get('/report.bin'), Buffer.from('preserved'));
  assert.ok(host.messages.some((message) => message.type === 'error' && /Upload validation failed/.test(message.error)));
  assertNoRemoteStaging(server);

  host.setWarningResponse('Replace');
  const localTarget = path.join(host.panel.workspaceRoot, 'report.bin');
  await host.send({ type: 'copy', source: 'remote', paths: ['/report.bin'] });
  assert.deepEqual(await fs.readFile(localTarget), Buffer.from('new payload'));
  assert.ok(host.messages.some((message) => message.type === 'error' && /Download validation failed/.test(message.error)));
  await assertNoLocalStaging(host.panel.workspaceRoot);
  assert.equal(copyProgress(host).at(-1), null);
});
