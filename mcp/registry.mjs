import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';

const maxRecords = 16;
const maxRecordBytes = 16 * 1024;

export async function validateRegistryDirectory(registry) {
  if (process.platform === 'win32') throw new Error('Direct Codex MCP registration requires verified private Windows ACL support.');
  const directory = await fs.lstat(registry);
  if (directory.isSymbolicLink() || !directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) {
    throw new Error('The FTP MCP registry is not a private directory owned by the current user.');
  }
}

export async function findGrantedBridge(registry) {
  await validateRegistryDirectory(registry);
  const names = (await fs.readdir(registry)).filter((name) => name.endsWith('.json')).sort();
  if (names.length > maxRecords) throw new Error('The FTP MCP registry contains too many grant records. Revoke unused grants in bm.ftp.');

  const records = [];
  for (const name of names) {
    const recordPath = path.join(registry, name);
    const stat = await fs.lstat(recordPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > maxRecordBytes) {
      throw new Error('An FTP MCP grant record is not a safe private file. Remove the invalid grant record and grant access again.');
    }
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    if (isRecord(record) && name === `${record.bridgeId}.json`) records.push(record);
  }
  const live = (await Promise.all(records.map(async (record) => await probe(record) ? record : undefined))).filter(Boolean);
  if (live.length === 0) throw new Error('FTP agent access is not currently granted. Open bm.ftp and grant read-only access.');
  if (live.length > 1) throw new Error('More than one FTP session has agent access. Revoke the other grants in bm.ftp.');
  return live[0];
}

function isRecord(value) {
  return value && typeof value === 'object'
    && /^[a-f0-9]{32}$/.test(value.bridgeId)
    && typeof value.endpoint === 'string' && value.endpoint.length > 0 && value.endpoint.length < 512
    && /^[a-f0-9]{64}$/.test(value.token)
    && typeof value.generation === 'string' && value.generation.length > 0;
}

function probe(record) {
  return new Promise((resolve) => {
    const socket = net.createConnection(record.endpoint);
    let response = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), 1800);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'probe', token: record.token, method: 'get_session', params: {} })}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, 'utf8') > 64 * 1024) return finish(false);
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      try {
        const value = JSON.parse(response.slice(0, newline));
        finish(value.id === 'probe' && !value.error && value.result?.connected === true);
      } catch { finish(false); }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}
