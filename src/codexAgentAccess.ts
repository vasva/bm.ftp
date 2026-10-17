import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { AgentBridge } from './agentBridge';

export interface CodexGrantRecord {
  bridgeId: string;
  endpoint: string;
  token: string;
  generation: string;
}

export function getCodexRuntimePaths(globalStoragePath: string): { runtime: string; grants: string; launcher: string; serverEntry: string } {
  const runtime = path.join(globalStoragePath, 'codex-mcp');
  return { runtime, grants: path.join(runtime, 'grants'), launcher: path.join(runtime, 'launcher.mjs'), serverEntry: path.join(runtime, 'server-entry.json') };
}

export async function installCodexLauncher(source: string, runtime: string, launcher: string): Promise<void> {
  await ensurePrivateDirectory(runtime);
  await installPrivateExecutable(source, launcher);
  await installPrivateExecutable(path.join(path.dirname(source), 'registry.mjs'), path.join(runtime, 'registry.mjs'));
}

async function installPrivateExecutable(source: string, destination: string): Promise<void> {
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o700);
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function installCodexServerEntry(file: string, entrypoint: string): Promise<void> {
  if (!path.isAbsolute(entrypoint)) throw new Error('The MCP server entry point must be an absolute path.');
  const directory = path.dirname(file);
  await ensurePrivateDirectory(directory);
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ entrypoint }), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function isCodexConfigured(runtime: string): Promise<boolean> {
  try {
    const info = await fs.lstat(runtime);
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.()) return false;
    const mode = info.mode & 0o777;
    if ((mode & 0o077) !== 0) return false;
    const launcher = await fs.lstat(path.join(runtime, 'launcher.mjs'));
    return !launcher.isSymbolicLink() && launcher.isFile() && launcher.uid === process.getuid?.() && (launcher.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

export async function publishCodexGrant(grantsDirectory: string, bridge: AgentBridge, generation: string): Promise<string> {
  const parentInfo = await fs.lstat(path.dirname(grantsDirectory));
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o077) !== 0) {
    throw new Error('The Codex MCP runtime directory is not a private directory owned by the current user.');
  }
  const info = await fs.lstat(grantsDirectory);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('The Codex MCP registry is not a private directory owned by the current user.');
  }
  const file = path.join(grantsDirectory, `${bridge.bridgeId}.json`);
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const record: CodexGrantRecord = {
    bridgeId: bridge.bridgeId,
    endpoint: bridge.endpoint,
    token: bridge.token,
    generation
  };
  try {
    await fs.writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    await fs.rm(file, { force: true });
    throw error;
  }
  return file;
}

export async function removeCodexGrant(file: string | undefined): Promise<void> {
  if (file) await fs.rm(file, { force: true });
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') throw new Error('Direct Codex MCP registration is currently supported on macOS and Linux only; Windows ACL validation is still required.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== process.getuid?.()) {
    throw new Error('The Codex MCP runtime directory is not a private directory owned by the current user.');
  }
  await fs.chmod(directory, 0o700);
  const secured = await fs.lstat(directory);
  if ((secured.mode & 0o077) !== 0) throw new Error('Could not secure the Codex MCP runtime directory permissions.');
}
