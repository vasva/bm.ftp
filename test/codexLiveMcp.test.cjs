const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AgentBridge } = require('../out/agentBridge.js');
const { installCodexServerEntry, publishCodexGrant, removeCodexGrant } = require('../out/codexAgentAccess.js');

test('Codex MCP stays running while FTP access is granted, revoked, and granted again', async (t) => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmftp-codex-live-'));
  await fs.chmod(root, 0o700);
  const runtime = path.join(root, 'runtime');
  const grants = path.join(runtime, 'grants');
  await fs.mkdir(grants, { recursive: true, mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverEntry = path.resolve(__dirname, '../mcp/server.mjs');
  await installCodexServerEntry(path.join(runtime, 'server-entry.json'), serverEntry);

  const env = { ...process.env };
  delete env.BM_FTP_AGENT_ENDPOINT;
  delete env.BM_FTP_AGENT_TOKEN;
  delete env.BM_FTP_AGENT_REGISTRY;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, '../mcp/codex-launcher.mjs'), '--registry', grants],
    env,
    stderr: 'pipe'
  });
  const client = new Client({ name: 'bm-ftp-codex-live-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_session', 'list_directory', 'read_file', 'search_files']);
  const unavailable = await client.callTool({ name: 'get_session', arguments: {} });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /not currently granted/);

  let sessionId = 'session-a';
  const makeBridge = async () => {
    const bridge = new AgentBridge(async ({ method, params }) => {
      if (method === 'get_session') return { sessionId, connected: true, protocol: 'ftps', allowedRoot: '/', capabilities: ['list_directory', 'search_files', 'read_file'], limits: {} };
      if (params.sessionId !== sessionId) throw new Error('The FTP session changed. Initialize the agent connection again.');
      return { path: params.path ?? '/', entries: [{ name: sessionId, kind: 'file' }] };
    });
    await bridge.start();
    t.after(() => bridge.dispose());
    return bridge;
  };

  const bridgeA = await makeBridge();
  const grantA = await publishCodexGrant(grants, bridgeA, 'session-a');
  const sessionA = await client.callTool({ name: 'get_session', arguments: {} });
  assert.equal(sessionA.structuredContent.sessionId, 'session-a');
  const listingA = await client.callTool({ name: 'list_directory', arguments: { sessionId: 'session-a', path: '/' } });
  assert.equal(listingA.structuredContent.entries[0].name, 'session-a');

  await removeCodexGrant(grantA);
  bridgeA.dispose();
  const revoked = await client.callTool({ name: 'list_directory', arguments: { sessionId: 'session-a', path: '/' } });
  assert.equal(revoked.isError, true);
  assert.match(revoked.content[0].text, /not currently granted/);

  sessionId = 'session-b';
  const bridgeB = await makeBridge();
  await publishCodexGrant(grants, bridgeB, 'session-b');
  const stale = await client.callTool({ name: 'list_directory', arguments: { sessionId: 'session-a', path: '/' } });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /session changed/);
  const sessionB = await client.callTool({ name: 'get_session', arguments: {} });
  assert.equal(sessionB.structuredContent.sessionId, 'session-b');
  const listingB = await client.callTool({ name: 'list_directory', arguments: { sessionId: 'session-b', path: '/' } });
  assert.equal(listingB.structuredContent.entries[0].name, 'session-b');
});
