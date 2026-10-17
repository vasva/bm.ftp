const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentBridge } = require('../out/agentBridge.js');
const { publishCodexGrant, installCodexLauncher, installCodexServerEntry, getCodexRuntimePaths, isCodexConfigured } = require('../out/codexAgentAccess.js');

let registryPromise;
async function registryModule() {
  registryPromise ??= import('../mcp/registry.mjs');
  return registryPromise;
}

async function registry(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmftp-codex-test-'));
  await fs.chmod(root, 0o700);
  const runtime = path.join(root, 'runtime');
  await fs.mkdir(runtime, { mode: 0o700 });
  const grants = path.join(runtime, 'grants');
  await fs.mkdir(grants, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, runtime, grants };
}

async function bridge(t) {
  const value = new AgentBridge(async () => ({ connected: true, sessionId: 'test-session' }));
  await value.start();
  t.after(() => value.dispose());
  return value;
}

test('Codex runtime paths stay under extension global storage', () => {
  const value = getCodexRuntimePaths('/private/global-storage');
  assert.equal(value.runtime, '/private/global-storage/codex-mcp');
  assert.equal(value.grants, '/private/global-storage/codex-mcp/grants');
  assert.equal(value.launcher, '/private/global-storage/codex-mcp/launcher.mjs');
  assert.equal(value.serverEntry, '/private/global-storage/codex-mcp/server-entry.json');
});

test('publishing a grant writes a private session record without an expiry', async (t) => {
  const { grants } = await registry(t);
  const activeBridge = await bridge(t);
  const file = await publishCodexGrant(grants, activeBridge, 'test-generation');
  const stat = await fs.stat(file);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(record.bridgeId, activeBridge.bridgeId);
  assert.equal(record.token, activeBridge.token);
  assert.equal(record.generation, 'test-generation');
  assert.equal('expiresAt' in record, false);
  assert.equal('entrypoint' in record, false);
});

test('installing the Codex server pointer writes a private stable entry point', async (t) => {
  const { runtime } = await registry(t);
  const file = path.join(runtime, 'server-entry.json');
  await installCodexServerEntry(file, '/extension/mcp/server.mjs');
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { entrypoint: '/extension/mcp/server.mjs' });
});

test('installed Codex launcher starts the server using its installed registry helper', async (t) => {
  const { runtime, grants } = await registry(t);
  const launcher = path.join(runtime, 'launcher.mjs');
  const source = path.resolve('mcp/codex-launcher.mjs');
  await installCodexLauncher(source, runtime, launcher);
  await installCodexServerEntry(path.join(runtime, 'server-entry.json'), path.resolve('mcp/server.mjs'));
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher, '--registry', grants],
    env: process.env,
    stderr: 'pipe'
  });
  let serverStderr = '';
  transport.stderr?.on('data', (chunk) => { serverStderr += String(chunk); });
  const client = new Client({ name: 'installed-launcher-test', version: '1.0.0' });
  t.after(() => client.close());
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${serverStderr ? `; stderr: ${serverStderr}` : ''}`);
  }
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_session', 'list_directory', 'read_file', 'search_files']);
});

test('Codex integration remains opted out until its launcher has been explicitly installed', async (t) => {
  const { runtime } = await registry(t);
  const unconfigured = path.join(runtime, 'not-installed');
  assert.equal(await isCodexConfigured(unconfigured), false);
  assert.equal(await fs.access(unconfigured).then(() => true, () => false), false);
  assert.equal(await isCodexConfigured(runtime), false);
  const launcherPath = path.join(runtime, 'launcher.mjs');
  await fs.writeFile(launcherPath, '#!/usr/bin/env node', { mode: 0o700 });
  assert.equal(await isCodexConfigured(runtime), true);
});

test('Codex discovery binds to the only live explicitly granted bridge', async (t) => {
  const { grants } = await registry(t);
  const activeBridge = await bridge(t);
  await publishCodexGrant(grants, activeBridge, 'generation-one', '/extension/mcp/server.mjs');
  const result = await (await registryModule()).findGrantedBridge(grants);
  assert.equal(result.bridgeId, activeBridge.bridgeId);
  assert.equal(result.generation, 'generation-one');
});

test('Codex discovery fails closed when there is no live grant', async (t) => {
  const { grants } = await registry(t);
  await assert.rejects((await registryModule()).findGrantedBridge(grants), /not currently granted/);
});

test('Codex discovery rejects multiple live grants instead of selecting a window', async (t) => {
  const { grants } = await registry(t);
  const first = await bridge(t);
  const second = await bridge(t);
  await publishCodexGrant(grants, first, 'generation-one', '/extension/mcp/server.mjs');
  await publishCodexGrant(grants, second, 'generation-two', '/extension/mcp/server.mjs');
  await assert.rejects((await registryModule()).findGrantedBridge(grants), /more than one FTP session/i);
});

test('Codex discovery rejects an insecure registry directory', async (t) => {
  const { grants } = await registry(t);
  await fs.chmod(grants, 0o755);
  await assert.rejects((await registryModule()).findGrantedBridge(grants), /private directory/);
});
