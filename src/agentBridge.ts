import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AgentRequest {
  method: string;
  params: Record<string, unknown>;
}

export class AgentBridge {
  readonly bridgeId = randomBytes(16).toString('hex');
  readonly token = randomBytes(32).toString('hex');
  readonly endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\bmftp-${randomBytes(16).toString('hex')}`
    : path.join(os.tmpdir(), `bmftp-${randomBytes(12).toString('hex')}.sock`);
  private readonly server = net.createServer((socket) => {
    if (this.sockets.size >= 8) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setTimeout(35_000, () => socket.destroy());
    socket.setEncoding('utf8');
    let pending = '';
    let receivedRequest = false;
    socket.on('data', (chunk: string) => {
      pending += chunk;
      if (Buffer.byteLength(pending, 'utf8') > 64 * 1024) {
        socket.destroy(new Error('Request frame is too large.'));
        return;
      }
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        if (receivedRequest) { socket.destroy(); return; }
        receivedRequest = true;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        void this.handleLine(line, socket);
      }
    });
  });
  private readonly sockets = new Set<net.Socket>();
  private disposed = false;

  constructor(private readonly handle: (request: AgentRequest) => Promise<unknown>) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.endpoint, () => {
        this.server.removeListener('error', onError);
        resolve();
      });
    });
    if (process.platform !== 'win32') {
      try { await fs.chmod(this.endpoint, 0o600); }
      catch (error) { this.dispose(); throw error; }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.server.listening) this.server.close();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (process.platform !== 'win32') void fs.rm(this.endpoint, { force: true });
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let id: unknown;
    try {
      if (Buffer.byteLength(line, 'utf8') > 32 * 1024) throw new Error('Request frame is too large.');
      const message = JSON.parse(line) as { id?: unknown; token?: unknown; method?: unknown; params?: unknown };
      id = message.id;
      if (typeof message.token !== 'string' || !safeEqual(message.token, this.token)) throw new Error('Access denied.');
      if (typeof message.method !== 'string' || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) {
        throw new Error('Invalid request.');
      }
      const result = await this.handle({ method: message.method, params: message.params as Record<string, unknown> });
      if (!this.disposed && !socket.destroyed) socket.write(`${JSON.stringify({ id, result })}\n`);
    } catch (error) {
      if (!this.disposed && !socket.destroyed) socket.write(`${JSON.stringify({ id, error: error instanceof Error ? error.message : 'Request failed.' })}\n`);
    }
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
