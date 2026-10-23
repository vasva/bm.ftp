const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  OperationQueue,
  validateProfile,
  normalizeRemotePath,
  validateFolderName,
  getPasswordKey,
  sortEntries,
  readLocalEntries,
  getLocalDestinationState,
  getSafeDownloadTarget,
  downloadAtomically,
  replaceRemoteFile
} = require('../out/core.js');
const { hasVisibleFileSelection } = require('../out/test-webview/selection.js');

test('operation queue serializes overlapping work and recovers after rejection', async () => {
  const queue = new OperationQueue();
  const events = [];
  let active = 0;
  let maxActive = 0;
  const task = (name, fail = false) => queue.enqueue(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`${name}:end`);
    active -= 1;
    if (fail) throw new Error(name);
    return name;
  });

  const first = task('first');
  const failed = task('failed', true);
  const third = task('third');
  await first;
  await assert.rejects(failed, /failed/);
  assert.equal(await third, 'third');
  assert.equal(maxActive, 1);
  assert.deepEqual(events, ['first:start', 'first:end', 'failed:start', 'failed:end', 'third:start', 'third:end']);
});

test('closing the operation queue skips work that has not started', async () => {
  const queue = new OperationQueue();
  let finishFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let queuedOperationRan = false;
  const first = queue.enqueue(() => new Promise((resolve) => { finishFirst = resolve; markStarted(); }));
  const queued = queue.enqueue(async () => { queuedOperationRan = true; });
  await started;
  queue.close();
  finishFirst();
  await Promise.all([first, queued]);
  assert.equal(queuedOperationRan, false);
});

test('connection profile validation covers defaults, boundaries, and invalid fields', () => {
  assert.deepEqual(validateProfile({ host: ' ftp.example.com ', username: ' user ' }), {
    host: 'ftp.example.com', port: 21, username: 'user', protocol: 'ftps'
  });
  assert.equal(validateProfile({ host: 'h', username: 'u', port: 1 }).port, 1);
  assert.equal(validateProfile({ host: 'h', username: 'u', port: 65535 }).port, 65535);
  for (const raw of [
    { host: '', username: 'u' },
    { host: 'bad host', username: 'u' },
    { host: 'h', username: '' },
    { host: 'h', username: 'u', port: 0 },
    { host: 'h', username: 'u', port: 65536 },
    { host: 'h', username: 'u', port: 2.5 },
    { host: 'h', username: 'u', port: Number.NaN }
  ]) assert.throws(() => validateProfile(raw));
});

test('profile validation keeps SFTP and applies protocol-specific port defaults', () => {
  assert.deepEqual(validateProfile({ host: 'ssh.example', username: 'user', protocol: 'sftp' }), {
    host: 'ssh.example', port: 22, username: 'user', protocol: 'sftp'
  });
  assert.equal(validateProfile({ host: 'ftp.example', username: 'user', protocol: 'ftp' }).port, 21);
  assert.equal(validateProfile({ host: 'ssh.example', username: 'user', protocol: 'sftp', port: 2022 }).port, 2022);
  assert.throws(() => validateProfile({ host: 'x', username: 'u', protocol: 'scp' }), /Choose FTP, FTPS, or SFTP/);
});

test('remote paths are rooted and reject FTP command separators', () => {
  assert.equal(normalizeRemotePath('../folder//file.txt'), '/folder/file.txt');
  assert.equal(normalizeRemotePath('/a/../b'), '/b');
  for (const invalid of ['/a\nb', '/a\rb', '/a\0b']) assert.throws(() => normalizeRemotePath(invalid), /invalid character/);
});

test('folder name validation rejects blank names, path segments, separators, and controls', () => {
  assert.equal(validateFolderName('  report  '), undefined);
  assert.equal(validateFolderName('résumé'), undefined);
  for (const invalid of ['', '  ', '.', '..', 'a/b', 'a\\b', 'a\n']) assert.ok(validateFolderName(invalid));
});

test('credential identity normalizes host casing and separates port, protocol, and user', () => {
  const profile = { host: 'FTP.Example.com', port: 21, username: 'my user', protocol: 'ftps' };
  assert.equal(getPasswordKey(profile), getPasswordKey({ ...profile, host: 'ftp.example.com' }));
  assert.notEqual(getPasswordKey(profile), getPasswordKey({ ...profile, port: 2121 }));
  assert.notEqual(getPasswordKey(profile), getPasswordKey({ ...profile, protocol: 'ftp' }));
  assert.notEqual(getPasswordKey(profile), getPasswordKey({ ...profile, username: 'other' }));
});

test('entries sort directories before case-insensitive file names', () => {
  const entries = [
    { name: 'z.txt', kind: 'file' }, { name: 'Beta', kind: 'directory' },
    { name: 'alpha.txt', kind: 'file' }, { name: 'alpha', kind: 'directory' }
  ];
  assert.deepEqual(entries.sort(sortEntries).map((entry) => entry.name), ['alpha', 'Beta', 'alpha.txt', 'z.txt']);
});

test('copy selection requires a visible file and matches names case-insensitively', () => {
  const entries = [
    { name: 'Readme.MD', path: '/x/Readme.MD', kind: 'file', size: 1 },
    { name: 'folder', path: '/x/folder', kind: 'directory', size: 0 }
  ];
  assert.equal(hasVisibleFileSelection(entries, '/x/Readme.MD', ' read '), true);
  assert.equal(hasVisibleFileSelection(entries, '/x/Readme.MD', 'folder'), false);
  assert.equal(hasVisibleFileSelection(entries, '/x/folder', ''), false);
  assert.equal(hasVisibleFileSelection(entries, '/x/missing', ''), false);
});

test('local listing handles empty folders, symlink targets, and dangling links', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-ftp-list-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readLocalEntries(root), []);
  await fs.mkdir(path.join(root, 'folder'));
  await fs.writeFile(path.join(root, 'z.txt'), 'z');
  await fs.writeFile(path.join(root, 'a.txt'), 'a');
  try {
    await fs.symlink(path.join(root, 'folder'), path.join(root, 'folder-link'), 'dir');
    await fs.symlink(path.join(root, 'absent'), path.join(root, 'broken-link'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('Symlinks are unavailable on this filesystem.');
    throw error;
  }
  const entries = await readLocalEntries(root);
  assert.deepEqual(entries.map(({ name, kind }) => [name, kind]), [
    ['folder', 'directory'], ['folder-link', 'directory'], ['a.txt', 'file'], ['broken-link', 'file'], ['z.txt', 'file']
  ]);
});

test('atomic download creates and replaces files, but partial failure preserves the previous file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-ftp-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'data.txt');
  await downloadAtomically(target, (staging) => fs.writeFile(staging, 'new file'));
  assert.equal(await fs.readFile(target, 'utf8'), 'new file');

  await assert.rejects(downloadAtomically(target, async (staging) => {
    await fs.writeFile(staging, 'partial');
    throw new Error('transfer interrupted');
  }), /interrupted/);
  assert.equal(await fs.readFile(target, 'utf8'), 'new file');
  assert.deepEqual((await fs.readdir(root)).sort(), ['data.txt']);

  await downloadAtomically(target, (staging) => fs.writeFile(staging, 'replacement'));
  assert.equal(await fs.readFile(target, 'utf8'), 'replacement');
});

test('atomic download uses a bounded staging name for a maximum-length destination name', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-ftp-long-name-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'x'.repeat(240));
  let stagingPath;
  await downloadAtomically(target, async (staging) => {
    stagingPath = staging;
    await fs.writeFile(staging, 'ok');
  });
  assert.ok(path.basename(stagingPath).length < 64);
  assert.equal(await fs.readFile(target, 'utf8'), 'ok');
});

test('destination inspection sees dangling links and rejects directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bm-ftp-dest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missing = path.join(root, 'missing.txt');
  assert.equal(await getLocalDestinationState(missing), 'missing');
  const file = path.join(root, 'file.txt');
  await fs.writeFile(file, 'old');
  assert.equal(await getLocalDestinationState(file), 'exists');
  const directory = path.join(root, 'folder');
  await fs.mkdir(directory);
  await assert.rejects(getLocalDestinationState(directory), /destination is a folder/i);
  try {
    const dangling = path.join(root, 'dangling-link');
    await fs.symlink(path.join(root, 'nowhere'), dangling, 'file');
    assert.equal(await getLocalDestinationState(dangling), 'exists');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip('Symlinks are unavailable on this filesystem.');
  }
});

test('remote filenames cannot escape the local destination on Windows or POSIX', () => {
  assert.deepEqual(getSafeDownloadTarget('/workspace', '/folder/notes.txt'), { name: 'notes.txt', path: path.resolve('/workspace/notes.txt') });
  assert.deepEqual(getSafeDownloadTarget('/workspace', '/folder/notes – Δ.txt'), { name: 'notes – Δ.txt', path: path.resolve('/workspace/notes – Δ.txt') });
  for (const remotePath of ['/folder/..\\..\\outside.txt', '/folder/C:outside.txt']) {
    assert.throws(() => getSafeDownloadTarget('/workspace', remotePath), /cannot be saved safely/);
  }
});

function memoryRemote(initial = {}) {
  const files = new Map(Object.entries(initial));
  const rename = async (from, to) => {
    if (!files.has(from)) throw new Error(`missing ${from}`);
    files.set(to, files.get(from));
    files.delete(from);
  };
  const remove = async (remotePath) => { files.delete(remotePath); };
  return { files, rename, remove };
}

test('remote upload stages new files and backs up/replaces existing files', async () => {
  const remote = memoryRemote({ '/folder/existing.txt': 'old' });
  await replaceRemoteFile(async (staging) => remote.files.set(staging, 'new'), '/folder/existing.txt', true, remote.rename, remote.remove);
  assert.equal(remote.files.get('/folder/existing.txt'), 'new');
  assert.equal(remote.files.size, 1);

  await replaceRemoteFile(async (staging) => remote.files.set(staging, 'created'), '/folder/new.txt', false, remote.rename, remote.remove);
  assert.equal(remote.files.get('/folder/new.txt'), 'created');
  assert.equal(remote.files.size, 2);
});

test('failed remote upload keeps the original and removes its staging file', async () => {
  const remote = memoryRemote({ '/x/file.txt': 'original' });
  await assert.rejects(replaceRemoteFile(async (staging) => {
    remote.files.set(staging, 'partial');
    throw new Error('upload interrupted');
  }, '/x/file.txt', true, remote.rename, remote.remove), /interrupted/);
  assert.equal(remote.files.get('/x/file.txt'), 'original');
  assert.deepEqual([...remote.files.keys()], ['/x/file.txt']);
});

test('failed remote promotion restores the original file and cleans staging', async () => {
  const remote = memoryRemote({ '/x/file.txt': 'original' });
  const rename = async (from, to) => {
    if (from.endsWith('.uploading')) throw new Error('rename unsupported');
    return remote.rename(from, to);
  };
  await assert.rejects(replaceRemoteFile(async (staging) => remote.files.set(staging, 'replacement'), '/x/file.txt', true, rename, remote.remove), /rename unsupported/);
  assert.equal(remote.files.get('/x/file.txt'), 'original');
  assert.deepEqual([...remote.files.keys()], ['/x/file.txt']);
});

test('remote rollback failure reports where the original backup remains', async () => {
  const remote = memoryRemote({ '/x/file.txt': 'original' });
  let backupPath;
  const rename = async (from, to) => {
    if (from.endsWith('.uploading')) throw new Error('promotion failed');
    if (from.endsWith('.backup')) {
      backupPath = from;
      throw new Error('rollback failed');
    }
    return remote.rename(from, to);
  };
  await assert.rejects(
    replaceRemoteFile(async (staging) => remote.files.set(staging, 'replacement'), '/x/file.txt', true, rename, remote.remove),
    (error) => error.message.includes(backupPath) && error.message.includes('rollback failed')
  );
  assert.equal(remote.files.get(backupPath), 'original');
});

test('remote replacement reports a backup cleanup failure after promotion', async () => {
  const remote = memoryRemote({ '/x/file.txt': 'original' });
  await assert.rejects(
    replaceRemoteFile(async (staging) => remote.files.set(staging, 'replacement'), '/x/file.txt', true, remote.rename,
      async (remotePath) => {
        if (remotePath.endsWith('.backup')) throw new Error('delete denied');
        return remote.remove(remotePath);
      }),
    /replacement was uploaded.*delete denied/
  );
  assert.equal(remote.files.get('/x/file.txt'), 'replacement');
  assert.equal([...remote.files.values()].includes('original'), true);
});
