import type { ConnectionProfile } from './core';

export interface RemoteEntry {
  name: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  modifiedAt?: Date;
}
export type ProgressType = 'upload' | 'download';

export interface RemoteTransport {
  readonly closed: boolean;
  readonly protocol: ConnectionProfile['protocol'];
  connect(profile: ConnectionProfile, password: string): Promise<string>;
  close(): void;
  list(directory: string): Promise<RemoteEntry[]>;
  ensureDir(directory: string, restoreDirectory?: string): Promise<void>;
  uploadFrom(localPath: string, remotePath: string): Promise<void>;
  downloadTo(destination: string | NodeJS.WritableStream, remotePath: string): Promise<void>;
  size(remotePath: string): Promise<number>;
  rename(from: string, to: string): Promise<unknown>;
  remove(remotePath: string): Promise<unknown>;
  removeDir(remotePath: string): Promise<unknown>;
  trackProgress(handler?: (info: { type: ProgressType; bytes: number }) => void): void;
  checkHealth(): Promise<void>;
}
