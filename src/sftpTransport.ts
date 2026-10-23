import { Client, utils } from 'ssh2';
import type { FileEntryWithStats, HostVerifier, SFTPWrapper, Stats } from 'ssh2';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import * as posix from 'node:path/posix';
import type { ConnectionProfile } from './core';
import type { ProgressType, RemoteEntry, RemoteTransport } from './remoteTransport';
import { commitHostKey, stageHostKey, type SecretStore } from './sftpHostKeys';

type HostConfirm = (message: string, changed: boolean) => Promise<'trust' | 'replace' | undefined>;
const asPromise = <T>(invoke: (callback: (error: Error | null | undefined, value: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => invoke((error, value) => error ? reject(error) : resolve(value)));

export class SftpTransport implements RemoteTransport {
  readonly protocol = 'sftp' as const;
  private client: Client | undefined;
  private sftp: SFTPWrapper | undefined;
  private progressHandler: ((info: { type: ProgressType; bytes: number }) => void) | undefined;
  private attempt = 0;
  private ended = true;
  private pendingCandidate: Awaited<ReturnType<typeof stageHostKey>> | undefined;

  constructor(
    private readonly secrets: SecretStore,
    private readonly confirmHost: HostConfirm,
    private readonly onConnectionLost: () => void = () => undefined
  ) {}
  get closed(): boolean { return this.ended || !this.sftp; }

  async connect(profile: ConnectionProfile, password: string): Promise<string> {
    this.close();
    const attempt = ++this.attempt;
    const client = new Client();
    this.client = client;
    this.ended = false;
    const isCurrent = (): boolean => attempt === this.attempt && this.client === client && !this.ended;
    let verifierError: Error | undefined;
    let verifierTask: Promise<void> | undefined;
    const connected = new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.once('close', () => reject(new Error('SSH connection closed during setup.')));
    });
    const signalConnectionEnd = (): void => {
      const wasConnected = this.sftp !== undefined && !this.ended;
      const isActiveAttempt = attempt === this.attempt && this.client === client;
      this.ended = true;
      this.sftp = undefined;
      if (wasConnected && isActiveAttempt) this.onConnectionLost();
    };
    client.on('close', signalConnectionEnd);
    client.on('error', signalConnectionEnd);
    client.connect({
      host: profile.host, port: profile.port, username: profile.username, password,
      keepaliveInterval: 15_000, keepaliveCountMax: 3,
      hostVerifier: ((rawKey, verify) => {
        verifierTask = (async () => {
          try {
            const keyInfo = utils.parseKey(rawKey);
            if (keyInfo instanceof Error) throw keyInfo;
            const candidate = await stageHostKey(this.secrets, profile.host, profile.port, keyInfo.type, rawKey, this.confirmHost, isCurrent);
            if (!isCurrent()) throw new Error('This SFTP connection attempt is no longer current.');
            this.pendingCandidate = candidate;
            verify(true);
          } catch (error) {
            verifierError = error instanceof Error ? error : new Error(String(error));
            verify(false);
          }
        })();
      }) as HostVerifier
    });
    try {
      await connected;
      if (verifierTask) await verifierTask;
      if (verifierError) throw verifierError;
      if (!isCurrent()) throw new Error('This SFTP connection attempt was cancelled.');
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, channel) => error ? reject(error) : resolve(channel)));
      if (!isCurrent()) { sftp.end(); throw new Error('This SFTP connection attempt was cancelled.'); }
      this.sftp = sftp;
      const home = await asPromise<string>((callback) => sftp.realpath('.', callback));
      const candidate = this.pendingCandidate;
      if (!candidate) throw new Error('SFTP host-key verification did not complete.');
      await commitHostKey(this.secrets, candidate, isCurrent);
      if (!isCurrent()) throw new Error('This SFTP connection attempt was cancelled.');
      this.pendingCandidate = undefined;
      return normalizeAbsolute(home);
    } catch (error) {
      if (this.client === client) this.close();
      throw verifierError ?? error;
    }
  }

  close(): void {
    this.attempt += 1;
    this.ended = true;
    this.sftp?.end();
    this.sftp = undefined;
    this.client?.end();
    this.client = undefined;
    this.pendingCandidate = undefined;
  }

  async list(directory: string): Promise<RemoteEntry[]> {
    const entries = await asPromise<FileEntryWithStats[]>((callback) => this.requireSftp().readdir(directory, callback));
    return entries.map(({ filename, attrs }) => ({ name: filename, size: attrs.size ?? 0, isFile: attrs.isFile(), isDirectory: attrs.isDirectory(), isSymbolicLink: attrs.isSymbolicLink(), modifiedAt: attrs.mtime === undefined ? undefined : new Date(attrs.mtime * 1000) }));
  }

  async ensureDir(directory: string): Promise<void> {
    const sftp = this.requireSftp();
    const target = normalizeAbsolute(directory);
    const segments = target.split('/').filter(Boolean);
    let current = '/';
    for (const segment of segments) {
      current = posix.join(current, segment);
      try {
        const attrs = await asPromise<Stats>((callback) => sftp.stat(current, callback));
        if (!attrs.isDirectory()) throw new Error(`SFTP path '${current}' already exists and is not a folder.`);
      } catch (error) {
        if (isMissing(error)) await asPromise<void>((callback) => sftp.mkdir(current, callback));
        else throw error;
      }
    }
  }

  async uploadFrom(localPath: string, remotePath: string): Promise<void> {
    const source = createReadStream(localPath);
    let bytes = 0;
    source.on('data', (chunk: Buffer | string) => { bytes += Buffer.byteLength(chunk); this.progressHandler?.({ type: 'upload', bytes }); });
    await pipeline(source, this.requireSftp().createWriteStream(remotePath, { flags: 'w' }));
  }

  async downloadTo(destination: string | NodeJS.WritableStream, remotePath: string): Promise<void> {
    const output = typeof destination === 'string' ? createWriteStream(destination) : destination;
    let bytes = 0;
    const source = this.requireSftp().createReadStream(remotePath);
    source.on('data', (chunk: Buffer | string) => { bytes += Buffer.byteLength(chunk); this.progressHandler?.({ type: 'download', bytes }); });
    await pipeline(source, output as NodeJS.WritableStream);
  }

  async size(remotePath: string): Promise<number> { return (await asPromise<Stats>((callback) => this.requireSftp().stat(remotePath, callback))).size; }
  rename(from: string, to: string): Promise<void> { return asPromise<void>((callback) => this.requireSftp().rename(from, to, callback)); }
  remove(remotePath: string): Promise<void> { return asPromise<void>((callback) => this.requireSftp().unlink(remotePath, callback)); }
  trackProgress(handler?: (info: { type: ProgressType; bytes: number }) => void): void { this.progressHandler = handler; }
  async checkHealth(): Promise<void> { if (this.closed) throw new Error('SSH connection is closed.'); }

  async removeDir(remotePath: string): Promise<void> {
    const directory = normalizeAbsolute(remotePath);
    for (const entry of await this.list(directory)) {
      const child = posix.join(directory, entry.name);
      if (entry.isSymbolicLink) await this.remove(child);
      else if (entry.isDirectory) await this.removeDir(child);
      else if (entry.isFile) await this.remove(child);
      else throw new Error(`Cannot safely delete unsupported SFTP entry '${child}'.`);
    }
    await asPromise<void>((callback) => this.requireSftp().rmdir(directory, callback));
  }

  private requireSftp(): SFTPWrapper {
    if (!this.sftp || this.ended) throw new Error('SFTP connection is closed.');
    return this.sftp;
  }
}

function normalizeAbsolute(value: string): string {
  if (!value.startsWith('/')) throw new Error('The SFTP server returned a non-absolute path.');
  return posix.resolve('/', value);
}
function isMissing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === '2' || error.code === 2); }
