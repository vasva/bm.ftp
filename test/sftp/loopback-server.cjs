const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE } } } = require('ssh2');
const { generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const posix = path.posix;
const constants = require('node:fs').constants;

class LoopbackSftpServer {
  constructor({ root, home = '/home/tester', username = 'tester', password = 'secret', hostKey, port = 0 } = {}) {
    this.root = root;
    this.home = home;
    this.username = username;
    this.password = password;
    this.listenPort = port;
    this.hostKey = hostKey ?? generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
    }).privateKey;
    this.authAttempts = 0;
    this.passwordAuthAttempts = 0;
    this.shellRequests = 0;
    this.execRequests = 0;
    this.forwardRequests = 0;
    this.ptyRequests = 0;
    this.failMkdir = new Set();
    this.failRename = new Set();
    this.failRead = new Set();
    this.failWrite = new Set();
    this.failStat = new Set();
    this.shortRead = new Set();
    this.sizeOverrides = new Map();
    this.sizeAdjustment = 0;
    this.clients = new Set();
  }

  async start() {
    await fs.mkdir(this.diskPath(this.home), { recursive: true });
    this.server = new Server({ hostKeys: [this.hostKey] }, (client) => {
      this.clients.add(client);
      client.on('error', () => {});
      client.on('close', () => this.clients.delete(client));
      client.on('authentication', (ctx) => {
        this.authAttempts += 1;
        if (ctx.method === 'password') this.passwordAuthAttempts += 1;
        if (ctx.method === 'password' && ctx.username === this.username && ctx.password === this.password) ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () => client.on('session', (accept) => {
        const session = accept();
        session.on('shell', (_accept, reject) => { this.shellRequests += 1; reject(); });
        session.on('exec', (_accept, reject) => { this.execRequests += 1; reject(); });
        session.on('pty', (_accept, reject) => { this.ptyRequests += 1; reject(); });
        session.on('tcpip', (_accept, reject) => { this.forwardRequests += 1; reject(); });
        session.on('sftp', (accept) => this.attachSftp(accept()));
      }));
    });
    this.server.on('tcpip', (_accept, reject) => { this.forwardRequests += 1; reject(); });
    this.server.on('request', (_accept, reject, name) => {
      if (name === 'tcpip-forward' || name === 'cancel-tcpip-forward') {
        this.forwardRequests += 1;
        reject();
      }
    });
    await new Promise((resolve) => this.server.listen(this.listenPort, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  async close() {
    for (const client of this.clients) client.end();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  diskPath(remotePath) {
    const normalized = posix.resolve('/', remotePath);
    const target = path.resolve(this.root, `.${normalized}`);
    const relative = path.relative(this.root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escaped fixture root.');
    return target;
  }

  async tree(remotePath = '/') {
    const target = this.diskPath(remotePath);
    const entries = [];
    for (const dirent of await fs.readdir(target, { withFileTypes: true })) {
      const full = posix.join(remotePath, dirent.name);
      const stat = await fs.lstat(this.diskPath(full));
      entries.push({ path: full, kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file', size: stat.size });
      if (stat.isDirectory()) entries.push(...await this.tree(full));
    }
    return entries;
  }

  attachSftp(sftp) {
    const handles = new Map();
    let nextHandle = 1;
    const makeHandle = (state) => {
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(nextHandle++);
      handles.set(handle.readUInt32BE(), state);
      return handle;
    };
    const getHandle = (handle) => handle?.length === 4 ? handles.get(handle.readUInt32BE()) : undefined;
    const fail = (reqid, error) => {
      const status = error?.code === 'EACCES' || error?.code === 'EPERM' ? STATUS_CODE.PERMISSION_DENIED
        : error?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE
          : error?.code === 'EEXIST' ? STATUS_CODE.FILE_ALREADY_EXISTS : STATUS_CODE.FAILURE;
      sftp.status(reqid, status, error?.message ?? 'Fixture operation failed');
    };
    const attrsFor = (stat, remotePath) => ({
      mode: stat.mode, uid: stat.uid, gid: stat.gid, size: this.sizeOverrides.get(remotePath) ?? stat.size + this.sizeAdjustment,
      atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000)
    });
    const doFs = (reqid, operation) => { Promise.resolve().then(operation).then(() => sftp.status(reqid, STATUS_CODE.OK), (error) => fail(reqid, error)); };
    const run = (reqid, operation) => { Promise.resolve().then(operation).catch((error) => fail(reqid, error)); };

    sftp.on('REALPATH', (reqid, remotePath) => {
      const resolved = remotePath === '.' || remotePath === '' ? this.home : posix.resolve('/', remotePath);
      sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} }]);
    });
    sftp.on('STAT', (reqid, remotePath) => run(reqid, async () => {
      if (this.failStat.has(remotePath)) throw Object.assign(new Error('Configured metadata failure'), { code: 'EIO' });
      sftp.attrs(reqid, attrsFor(await fs.stat(this.diskPath(remotePath)), remotePath));
    }));
    sftp.on('LSTAT', (reqid, remotePath) => run(reqid, async () => {
      if (this.failStat.has(remotePath)) throw Object.assign(new Error('Configured metadata failure'), { code: 'EIO' });
      sftp.attrs(reqid, attrsFor(await fs.lstat(this.diskPath(remotePath)), remotePath));
    }));
    sftp.on('OPENDIR', (reqid, remotePath) => run(reqid, async () => {
      const names = await fs.readdir(this.diskPath(remotePath));
      sftp.handle(reqid, makeHandle({ type: 'directory', path: remotePath, names, index: 0 }));
    }));
    sftp.on('READDIR', (reqid, handle) => run(reqid, async () => {
      const state = getHandle(handle);
      if (!state || state.type !== 'directory') throw Object.assign(new Error('Bad directory handle'), { code: 'EBADF' });
      const batch = state.names.slice(state.index, state.index + 50);
      if (!batch.length) return sftp.status(reqid, STATUS_CODE.EOF);
      state.index += batch.length;
      const entries = await Promise.all(batch.map(async (filename) => {
        const stat = await fs.lstat(this.diskPath(posix.join(state.path, filename)));
        const fullPath = posix.join(state.path, filename);
        return { filename, longname: filename, attrs: attrsFor(stat, fullPath) };
      }));
      sftp.name(reqid, entries);
    }));
    sftp.on('OPEN', (reqid, remotePath, flags) => run(reqid, async () => {
      const target = this.diskPath(remotePath);
      let flag = 'r';
      if (flags & OPEN_MODE.WRITE) flag = flags & OPEN_MODE.APPEND ? 'a+' : flags & OPEN_MODE.TRUNC ? 'w+' : 'r+';
      if ((flags & OPEN_MODE.CREAT) && !(flags & OPEN_MODE.TRUNC)) flag = 'a+';
      const file = await fs.open(target, flag);
      sftp.handle(reqid, makeHandle({ type: 'file', file, path: remotePath }));
    }));
    sftp.on('READ', (reqid, handle, offset, length) => run(reqid, async () => {
      const state = getHandle(handle);
      if (!state || state.type !== 'file') throw Object.assign(new Error('Bad file handle'), { code: 'EBADF' });
      if (this.failRead.has(state.path)) throw Object.assign(new Error('Configured read failure'), { code: 'EIO' });
      if (this.shortRead.has(state.path) && offset > 0) return sftp.status(reqid, STATUS_CODE.EOF);
      const buffer = Buffer.alloc(length);
      const result = await state.file.read(buffer, 0, length, offset);
      if (!result.bytesRead) return sftp.status(reqid, STATUS_CODE.EOF);
      const bytesRead = this.shortRead.has(state.path) ? Math.max(1, Math.floor(result.bytesRead / 2)) : result.bytesRead;
      sftp.data(reqid, buffer.subarray(0, bytesRead));
    }));
    sftp.on('WRITE', (reqid, handle, offset, data) => run(reqid, async () => {
      const state = getHandle(handle);
      if (!state || state.type !== 'file') throw Object.assign(new Error('Bad file handle'), { code: 'EBADF' });
      if (this.failWrite.has(state.path)) throw Object.assign(new Error('Configured write failure'), { code: 'EIO' });
      await state.file.write(data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    }));
    sftp.on('CLOSE', (reqid, handle) => run(reqid, async () => {
      const id = handle?.length === 4 ? handle.readUInt32BE() : undefined;
      const state = id === undefined ? undefined : handles.get(id);
      if (!state) throw Object.assign(new Error('Bad handle'), { code: 'EBADF' });
      handles.delete(id);
      if (state.file) await state.file.close();
      sftp.status(reqid, STATUS_CODE.OK);
    }));
    sftp.on('MKDIR', (reqid, remotePath) => {
      if (this.failMkdir.has(remotePath)) return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED, 'Configured mkdir denial');
      doFs(reqid, () => fs.mkdir(this.diskPath(remotePath)));
    });
    sftp.on('RENAME', (reqid, from, to) => {
      if (this.failRename.has(`${from}->${to}`)) return sftp.status(reqid, STATUS_CODE.FAILURE, 'Configured rename failure');
      doFs(reqid, () => fs.rename(this.diskPath(from), this.diskPath(to)));
    });
    sftp.on('REMOVE', (reqid, remotePath) => doFs(reqid, () => fs.unlink(this.diskPath(remotePath))));
    sftp.on('RMDIR', (reqid, remotePath) => doFs(reqid, () => fs.rmdir(this.diskPath(remotePath))));
  }
}

module.exports = { LoopbackSftpServer };
