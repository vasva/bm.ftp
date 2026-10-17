import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateRegistryDirectory } from './registry.mjs';

async function resolveEntrypoint(runtime) {
  const pointer = path.join(runtime, 'server-entry.json');
  const info = await fs.lstat(pointer);
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) {
    throw new Error('The installed bm.ftp MCP server pointer is not a safe private file. Run the Codex MCP setup command again.');
  }
  const value = JSON.parse(await fs.readFile(pointer, 'utf8'));
  if (!value || typeof value.entrypoint !== 'string' || !path.isAbsolute(value.entrypoint)) {
    throw new Error('The installed bm.ftp MCP server path is invalid. Run the Codex MCP setup command again.');
  }
  const entry = await fs.lstat(value.entrypoint);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.uid !== process.getuid?.()) {
    throw new Error('The installed bm.ftp MCP server entry point is not a regular file owned by the current user.');
  }
  return value.entrypoint;
}

export async function startCodexServer(registry) {
  if (!path.isAbsolute(registry)) throw new Error('The FTP MCP registry path must be absolute.');
  await validateRegistryDirectory(registry);
  const entrypoint = await resolveEntrypoint(path.dirname(registry));
  process.env.BM_FTP_AGENT_REGISTRY = registry;
  await import(pathToFileURL(entrypoint).href);
}

async function main() {
  const registryArgument = process.argv.indexOf('--registry');
  const registry = process.env.BM_FTP_AGENT_REGISTRY ?? (registryArgument >= 0 ? process.argv[registryArgument + 1] : undefined);
  if (!registry || !path.isAbsolute(registry)) throw new Error('The FTP MCP registry path is missing or is not absolute.');
  await startCodexServer(registry);
}

async function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const [invokedPath, modulePath] = await Promise.all([
      fs.realpath(process.argv[1]),
      fs.realpath(fileURLToPath(import.meta.url))
    ]);
    return invokedPath === modulePath;
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  main().catch((error) => {
    process.stderr.write(`bm.ftp MCP: ${error instanceof Error ? error.message : 'Could not start the FTP MCP server.'}\n`);
    process.exitCode = 1;
  });
}
