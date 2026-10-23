const net = require('node:net');
const path = require('node:path').posix;

class ReadOnlyFtpServer {
  constructor({
    username = 'tester', password = 'correct-password', files, directories, failListingPaths = [],
    writable = false, denyMkdirPaths = [], sizeAdjustments = {}, defaultSizeAdjustment = 0
  } = {}) {
    this.username = username;
    this.password = password;
    this.files = new Map(Object.entries(files ?? {
      '/welcome.txt': Buffer.from('loopback FTP content'),
      '/docs/readme.txt': Buffer.from('read-only nested file')
    }));
    this.directories = new Set(['/', ...(directories ?? ['/docs'])]);
    this.failListingPaths = new Set(failListingPaths);
    this.writable = writable;
    this.denyMkdirPaths = new Set(denyMkdirPaths);
    this.sizeAdjustments = new Map(Object.entries(sizeAdjustments));
    this.defaultSizeAdjustment = defaultSizeAdjustment;
    this.commands = [];
    this.sockets = new Set();
    this.server = net.createServer((socket) => this.acceptControl(socket));
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return this.server.address().port;
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise((resolve) => this.server.close(resolve));
  }

  acceptControl(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 loopback read-only fixture ready\r\n');
    let input = '';
    let cwd = '/';
    let authenticated = false;
    let passive;
    let renameFrom;

    socket.on('data', (chunk) => {
      input += chunk;
      let end;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const line = input.slice(0, end);
        input = input.slice(end + 2);
        void handle(line);
      }
    });

    const write = (line) => { if (!socket.destroyed) socket.write(`${line}\r\n`); };
    const disposePassive = () => {
      if (!passive) return;
      passive.socket?.destroy();
      if (passive.server.listening) passive.server.close();
      passive = undefined;
    };

    const handle = async (line) => {
      const separator = line.indexOf(' ');
      const command = (separator < 0 ? line : line.slice(0, separator)).toUpperCase();
      const argument = separator < 0 ? '' : line.slice(separator + 1);
      this.commands.push({ command, argument });

      switch (command) {
        case 'USER':
          write(argument === this.username ? '331 Password required' : '530 Unknown user');
          break;
        case 'PASS':
          authenticated = argument === this.password;
          write(authenticated ? '230 Login successful' : '530 Login incorrect');
          break;
        case 'FEAT':
          write('211-Features');
          write(' MLST type*;size*;modify*;');
          write(' UTF8');
          write('211 End');
          break;
        case 'OPTS':
          write('200 Option accepted');
          break;
        case 'TYPE':
        case 'STRU':
        case 'MODE':
          write('200 Setting accepted');
          break;
        case 'SYST':
          write('215 UNIX Type: L8');
          break;
        case 'PWD':
          write(`257 "${cwd}" is current directory`);
          break;
        case 'CWD': {
          const target = path.resolve(cwd, argument);
          if (!authenticated) write('530 Log in first');
          else if (!this.directories.has(target)) write('550 Directory unavailable');
          else {
            cwd = target;
            write('250 Directory changed');
          }
          break;
        }
        case 'EPSV': {
          disposePassive();
          passive = { server: net.createServer((dataSocket) => { passive.socket = dataSocket; }) };
          await new Promise((resolve, reject) => {
            passive.server.once('error', reject);
            passive.server.listen(0, '127.0.0.1', resolve);
          });
          write(`229 Entering Extended Passive Mode (|||${passive.server.address().port}|)`);
          break;
        }
        case 'MLSD':
        case 'LIST': {
          if (!authenticated) {
            write('530 Log in first');
            disposePassive();
            break;
          }
          const listingPath = argument ? path.resolve(cwd, argument) : cwd;
          if (this.failListingPaths.has(listingPath)) {
            write('550 Listing unavailable');
            disposePassive();
            break;
          }
          if (!passive) {
            write('425 Use EPSV first');
            break;
          }
          const listing = this.listingFor(listingPath);
          const activePassive = passive;
          write('150 Opening data connection');
          const finish = () => {
            activePassive.socket.end(listing);
            activePassive.server.close();
            if (passive === activePassive) passive = undefined;
            write('226 Transfer complete');
          };
          if (activePassive.socket) finish();
          else activePassive.server.once('connection', () => setImmediate(finish));
          break;
        }
        case 'RETR': {
          if (!authenticated) {
            write('530 Log in first');
            disposePassive();
            break;
          }
          const remotePath = path.resolve(cwd, argument);
          const content = this.files.get(remotePath);
          if (!content) {
            write('550 File unavailable');
            disposePassive();
            break;
          }
          if (!passive) {
            write('425 Use EPSV first');
            break;
          }
          const activePassive = passive;
          write('150 Opening data connection');
          const finish = () => {
            activePassive.socket.end(content);
            activePassive.server.close();
            if (passive === activePassive) passive = undefined;
            write('226 Transfer complete');
          };
          if (activePassive.socket) finish();
          else activePassive.server.once('connection', () => setImmediate(finish));
          break;
        }
        case 'STOR': {
          if (!authenticated) {
            write('530 Log in first');
            disposePassive();
            break;
          }
          const target = path.resolve(cwd, argument);
          if (!this.writable) {
            write('550 Read-only fixture');
            disposePassive();
            break;
          }
          if (path.dirname(target) !== '/' && !this.directories.has(path.dirname(target))) {
            write('550 Parent directory unavailable');
            disposePassive();
            break;
          }
          if (!passive) {
            write('425 Use EPSV first');
            break;
          }
          const activePassive = passive;
          write('150 Opening data connection');
          const receiveUpload = (dataSocket) => {
            const chunks = [];
            dataSocket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            dataSocket.once('end', () => {
              this.files.set(target, Buffer.concat(chunks));
              activePassive.server.close();
              if (passive === activePassive) passive = undefined;
              write('226 Transfer complete');
            });
          };
          if (activePassive.socket) receiveUpload(activePassive.socket);
          else activePassive.server.once('connection', receiveUpload);
          break;
        }
        case 'SIZE': {
          const target = path.resolve(cwd, argument);
          const content = this.files.get(target);
          if (!content || !authenticated) write('550 File unavailable');
          else write(`213 ${content.length + this.defaultSizeAdjustment + Number(this.sizeAdjustments.get(target) ?? 0)}`);
          break;
        }
        case 'MKD': {
          const target = path.resolve(cwd, argument);
          if (!authenticated || !this.writable || this.denyMkdirPaths.has(target) || !this.directories.has(path.dirname(target))) {
            write(this.writable ? '550 Directory creation denied' : '550 Read-only fixture');
          } else if (this.directories.has(target)) {
            write('550 Directory already exists');
          } else {
            this.directories.add(target);
            write(`257 "${target}" created`);
          }
          break;
        }
        case 'DELE': {
          const target = path.resolve(cwd, argument);
          if (!authenticated) write('530 Log in first');
          else if (!this.writable) write('550 Read-only fixture');
          else if (!this.files.delete(target)) write('550 File unavailable');
          else write('250 File deleted');
          break;
        }
        case 'RNFR': {
          const target = path.resolve(cwd, argument);
          if (!authenticated) write('530 Log in first');
          else if (!this.writable || !this.files.has(target)) {
            write(this.writable ? '550 File unavailable' : '550 Read-only fixture');
          } else {
            renameFrom = target;
            write('350 Ready for destination');
          }
          break;
        }
        case 'RNTO': {
          const target = path.resolve(cwd, argument);
          if (!authenticated) write('530 Log in first');
          else if (!this.writable) write('550 Read-only fixture');
          else if (!renameFrom || !this.files.has(renameFrom)) write('503 Send RNFR first');
          else {
            this.files.set(target, this.files.get(renameFrom));
            this.files.delete(renameFrom);
            renameFrom = undefined;
            write('250 Rename successful');
          }
          break;
        }
        case 'RMD':
          write(this.writable ? '502 Unsupported fixture command' : '550 Read-only fixture');
          break;
        case 'NOOP':
          write('200 No operation');
          break;
        case 'QUIT':
          write('221 Goodbye');
          socket.end();
          disposePassive();
          break;
        case 'APPE':
          write('502 Unsupported fixture command');
          disposePassive();
          break;
        default:
          write('502 Command not implemented');
      }
    };
  }

  listingFor(directory) {
    const rows = [];
    for (const child of this.directories) {
      if (child === directory || path.dirname(child) !== directory) continue;
      rows.push(`type=dir;modify=20261023000000; ${path.basename(child)}\r\n`);
    }
    for (const [filePath, content] of this.files) {
      if (path.dirname(filePath) !== directory) continue;
      const size = content.length + this.defaultSizeAdjustment + Number(this.sizeAdjustments.get(filePath) ?? 0);
      rows.push(`type=file;size=${size};modify=20261023000000; ${path.basename(filePath)}\r\n`);
    }
    return rows.join('');
  }
}

module.exports = { ReadOnlyFtpServer };
