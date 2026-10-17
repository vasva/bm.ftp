const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('stdio MCP server exposes read-only FTP tools through the authenticated bridge', async (t) => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\bmftp-test-${process.pid}-${Date.now()}`
    : path.join(os.tmpdir(), `bmftp-test-${process.pid}-${Date.now()}.sock`);
  const token = 'test-only-agent-token';
  const requests = [];
  const bridge = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk;
      const newline = pending.indexOf('\n');
      if (newline < 0) return;
      const message = JSON.parse(pending.slice(0, newline));
      requests.push(message);
      const result = message.method === 'get_session'
        ? { sessionId: 'session-1', connected: true, protocol: 'ftps', allowedRoot: '/', capabilities: ['list_directory', 'search_files', 'read_file'], limits: {} }
        : { path: message.params.path, text: 'safe test contents' };
      socket.end(`${JSON.stringify({ id: message.id, result })}\n`);
    });
  });
  if (process.platform !== 'win32') t.after(() => fs.rm(endpoint, { force: true }));
  await new Promise((resolve) => bridge.listen(endpoint, resolve));
  t.after(() => new Promise((resolve) => bridge.close(resolve)));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, '../mcp/server.mjs')],
    env: { ...process.env, BM_FTP_AGENT_ENDPOINT: endpoint, BM_FTP_AGENT_TOKEN: token },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'bm-ftp-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['get_session', 'list_directory', 'read_file', 'search_files']);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  const session = await client.callTool({ name: 'get_session', arguments: {} });
  assert.equal(session.structuredContent.sessionId, 'session-1');
  const file = await client.callTool({ name: 'read_file', arguments: { sessionId: 'session-1', path: '/README.md' } });
  assert.equal(file.structuredContent.text, 'safe test contents');
  assert.ok(requests.every((request) => request.token === token));
  assert.ok(requests.every((request) => !('password' in request.params)));
});
