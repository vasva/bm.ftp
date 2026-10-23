import { createHash } from 'node:crypto';

export interface SecretStore {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
}

export interface HostKeyRecord {
  version: 1;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  publicKey: string;
  acceptedAt: string;
}

export interface HostKeyCandidate {
  storageKey: string;
  originalValue: string | undefined;
  record: HostKeyRecord;
  shouldStore: boolean;
}

export function getHostKeyStorageKey(host: string, port: number): string {
  return `bm.ftp.sftp.hostkey.v1.${encodeURIComponent(canonicalHost(host))}.${port}`;
}

export function canonicalHost(host: string): string {
  return host.trim().replace(/^\[([\s\S]*)\]$/, '$1').toLowerCase();
}

export function getHostKeyFingerprint(publicKey: Buffer): string {
  return `SHA256:${createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '')}`;
}

export async function stageHostKey(
  secrets: SecretStore,
  host: string,
  port: number,
  algorithm: string,
  publicKey: Buffer,
  confirm: (message: string, changed: boolean) => Promise<'trust' | 'replace' | undefined>,
  isCurrent: () => boolean
): Promise<HostKeyCandidate> {
  const normalizedHost = canonicalHost(host);
  const storageKey = getHostKeyStorageKey(normalizedHost, port);
  const originalValue = await secrets.get(storageKey);
  let prior: HostKeyRecord | undefined;
  if (originalValue !== undefined) {
    try {
      const parsed = JSON.parse(originalValue) as Partial<HostKeyRecord>;
      if (parsed.version !== 1 || parsed.host !== normalizedHost || parsed.port !== port || typeof parsed.fingerprint !== 'string' || typeof parsed.publicKey !== 'string' || typeof parsed.algorithm !== 'string' || typeof parsed.acceptedAt !== 'string') throw new Error();
      const storedKey = Buffer.from(parsed.publicKey, 'base64');
      if (storedKey.toString('base64') !== parsed.publicKey || getHostKeyFingerprint(storedKey) !== parsed.fingerprint) throw new Error();
      prior = parsed as HostKeyRecord;
    } catch {
      throw new Error(`The saved SFTP host key for ${normalizedHost}:${port} is unreadable. Remove or repair the stored trust record before connecting.`);
    }
  }
  const publicKeyText = publicKey.toString('base64');
  const fingerprint = getHostKeyFingerprint(publicKey);
  if (prior?.publicKey === publicKeyText) {
    return { storageKey, originalValue, shouldStore: false, record: prior };
  }

  const changed = prior !== undefined;
  const details = changed
    ? `The SFTP host key for ${normalizedHost}:${port} has changed. A server change or interception is possible.\n\nStored: ${prior!.algorithm} ${prior!.fingerprint}\nPresented: ${algorithm} ${fingerprint}`
    : `Trust this SFTP host key?\n\nHost: ${normalizedHost}\nPort: ${port}\nAlgorithm: ${algorithm}\nFingerprint: ${fingerprint}`;
  const answer = await confirm(details, changed);
  if (!isCurrent()) throw new Error('This SFTP connection attempt is no longer current. Connect again.');
  if (answer !== (changed ? 'replace' : 'trust')) throw new Error('SFTP host key was not trusted.');

  const record: HostKeyRecord = { version: 1, host: normalizedHost, port, algorithm, fingerprint, publicKey: publicKeyText, acceptedAt: new Date().toISOString() };
  return { storageKey, originalValue, record, shouldStore: true };
}

export async function commitHostKey(secrets: SecretStore, candidate: HostKeyCandidate, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) throw new Error('This SFTP connection attempt is no longer current. Connect again.');
  const latest = await secrets.get(candidate.storageKey);
  if (!isCurrent()) throw new Error('This SFTP connection attempt is no longer current. Connect again.');
  if (latest !== candidate.originalValue) throw new Error('The saved SFTP host key changed while you were connecting. Review the host key and connect again.');
  if (!candidate.shouldStore) return;
  await secrets.store(candidate.storageKey, JSON.stringify(candidate.record));
}
