import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as posix from 'node:path/posix';

export type Protocol = 'ftp' | 'ftps';

export interface ConnectionProfile {
  host: string;
  port: number;
  username: string;
  protocol: Protocol;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  relativePath?: string;
  modified?: string;
  modifiedTime?: number;
}

export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => this.closed ? undefined as T : operation();
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  close(): void {
    this.closed = true;
  }
}

export function validateProfile(raw: Partial<ConnectionProfile>): ConnectionProfile {
  const host = (raw.host ?? '').trim();
  const username = (raw.username ?? '').trim();
  const port = Number(raw.port ?? 21);
  const protocol: Protocol = raw.protocol === 'ftp' ? 'ftp' : 'ftps';
  if (!host || /[\s\r\n]/.test(host)) throw new Error('Enter a valid FTP host.');
  if (!username) throw new Error('Enter the FTP username.');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Enter a port between 1 and 65535.');
  return { host, port, username, protocol };
}

export function normalizeRemotePath(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('FTP path contains an invalid character.');
  return posix.resolve('/', value);
}

export function validateFolderName(value: string): string | undefined {
  if (/[\\/\0-\x1f\x7f]/.test(value)) return 'Use a folder name without path separators or control characters.';
  const name = value.trim();
  if (!name) return 'Enter a folder name.';
  if (name === '.' || name === '..') return 'Use a folder name without path separators or control characters.';
  return undefined;
}

export function getPasswordKey(profile: ConnectionProfile): string {
  return `bm.ftp.password.${encodeURIComponent(profile.host.toLowerCase())}.${profile.port}.${profile.protocol}.${encodeURIComponent(profile.username)}`;
}

export function sortEntries<T extends Pick<FileEntry, 'kind' | 'name'>>(a: T, b: T): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export async function readLocalEntries(directory: string): Promise<FileEntry[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const mapped: FileEntry[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(fullPath);
    } catch (error) {
      if (isMissingEntry(error)) {
        try {
          stat = await fs.lstat(fullPath);
        } catch {
          continue;
        }
      } else {
        try {
          stat = await fs.lstat(fullPath);
        } catch {
          continue;
        }
      }
    }
    mapped.push({
      name: entry.name,
      path: fullPath,
      kind: stat.isDirectory() ? 'directory' as const : 'file' as const,
      size: stat.size,
      modified: stat.mtime.toLocaleDateString(),
      modifiedTime: stat.mtimeMs
    });
  }
  return mapped.sort(sortEntries);
}

export async function getLocalDestinationState(target: string): Promise<'missing' | 'exists'> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) throw new Error('The local destination is a folder.');
    return 'exists';
  } catch (error) {
    if (isMissingEntry(error)) return 'missing';
    throw error;
  }
}

export function getSafeDownloadTarget(localDirectory: string, remotePath: string): { name: string; path: string } {
  const name = posix.basename(normalizeRemotePath(remotePath));
  if (!name || name === '.' || name === '..' || /[\\/:]/.test(name) || path.isAbsolute(name) || path.win32.isAbsolute(name)) {
    throw new Error('The remote filename cannot be saved safely on this computer.');
  }
  const directory = path.resolve(localDirectory);
  const target = path.resolve(directory, name);
  if (path.dirname(target) !== directory) throw new Error('The remote filename cannot be saved outside the current local folder.');
  return { name, path: target };
}

export async function downloadAtomically(target: string, download: (stagingPath: string) => Promise<unknown>): Promise<void> {
  const staging = path.join(path.dirname(target), `.bmftp-${randomBytes(12).toString('hex')}.part`);
  try {
    await download(staging);
    await fs.rename(staging, target);
  } finally {
    await fs.rm(staging, { force: true }).catch(() => undefined);
  }
}

export async function replaceRemoteFile(
  upload: (stagingPath: string) => Promise<unknown>,
  target: string,
  targetExists: boolean,
  rename: (from: string, to: string) => Promise<unknown>,
  remove: (remotePath: string) => Promise<unknown>
): Promise<void> {
  const token = randomBytes(12).toString('hex');
  const directory = posix.dirname(target);
  const staging = posix.join(directory, `.bmftp-${token}.uploading`);
  const backup = posix.join(directory, `.bmftp-${token}.backup`);
  let originalMoved = false;
  try {
    await upload(staging);
    if (targetExists) {
      await rename(target, backup);
      originalMoved = true;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (originalMoved) {
        try {
          await rename(backup, target);
          originalMoved = false;
        } catch (rollbackError) {
          throw new Error(`Upload could not replace the remote file. Its original is preserved at '${backup}', but restoring it to the original name failed: ${errorMessage(rollbackError)}`, { cause: error });
        }
      }
      throw error;
    }
    if (originalMoved) {
      try {
        await remove(backup);
      } catch (error) {
        originalMoved = false;
        throw new Error(`The replacement was uploaded, but its backup could not be removed from '${backup}': ${errorMessage(error)}`, { cause: error });
      }
      originalMoved = false;
    }
  } finally {
    await remove(staging).catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingEntry(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
