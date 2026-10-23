import { Client } from 'basic-ftp';
import type { ConnectionProfile } from './core';
import type { ProgressType, RemoteEntry, RemoteTransport } from './remoteTransport';

export class FtpTransport implements RemoteTransport {
  readonly client = new Client(30_000);
  private currentProtocol: 'ftp' | 'ftps';

  constructor(protocol: 'ftp' | 'ftps') { this.currentProtocol = protocol; }
  get protocol(): 'ftp' | 'ftps' { return this.currentProtocol; }
  get closed(): boolean { return this.client.closed; }
  close(): void { this.client.close(); }
  async connect(profile: ConnectionProfile, password: string): Promise<string> {
    this.currentProtocol = profile.protocol === 'ftp' ? 'ftp' : 'ftps';
    await this.client.access({ host: profile.host, port: profile.port, user: profile.username, password, secure: profile.protocol === 'ftps' });
    return '/';
  }
  async list(directory: string): Promise<RemoteEntry[]> {
    return (await this.client.list(directory)).map(({ name, size, isFile, isDirectory, isSymbolicLink, modifiedAt }) => ({ name, size, isFile, isDirectory, isSymbolicLink, modifiedAt }));
  }
  async ensureDir(directory: string, restoreDirectory?: string): Promise<void> {
    await this.client.ensureDir(directory);
    if (restoreDirectory) await this.client.cd(restoreDirectory);
  }
  async uploadFrom(localPath: string, remotePath: string): Promise<void> { await this.client.uploadFrom(localPath, remotePath); }
  async downloadTo(destination: string | NodeJS.WritableStream, remotePath: string): Promise<void> { await this.client.downloadTo(destination as never, remotePath); }
  size(remotePath: string): Promise<number> { return this.client.size(remotePath); }
  rename(from: string, to: string): Promise<unknown> { return this.client.rename(from, to); }
  remove(remotePath: string): Promise<unknown> { return this.client.remove(remotePath); }
  removeDir(remotePath: string): Promise<unknown> { return this.client.removeDir(remotePath); }
  trackProgress(handler?: (info: { type: ProgressType; bytes: number }) => void): void {
    this.client.trackProgress(handler ? (info) => handler({ type: info.type as ProgressType, bytes: info.bytes }) : undefined);
  }
  async checkHealth(): Promise<void> { await this.client.sendIgnoringError('NOOP'); }
}
