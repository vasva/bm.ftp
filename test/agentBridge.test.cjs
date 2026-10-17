const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const test = require('node:test');
const { AgentBridge } = require('../out/agentBridge.js');

async function send(endpoint, message) {
  const socket = net.createConnection(endpoint);
  socket.setEncoding('utf8');
  await once(socket, 'connect');
  socket.write(`${message}\n`);
  let data = '';
  for await (const chunk of socket) {
    data += chunk;
    const newline = data.indexOf('\n');
    if (newline >= 0) {
      socket.destroy();
      return JSON.parse(data.slice(0, newline));
    }
  }
  throw new Error('Bridge closed without a response.');
}

test('agent bridge accepts an authenticated request and returns its result', async (t) => {
  const bridge = new AgentBridge(async ({ method, params }) => ({ method, params }));
  await bridge.start();
  t.after(() => bridge.dispose());
  const response = await send(bridge.endpoint, JSON.stringify({ id: 7, token: bridge.token, method: 'list_directory', params: { path: '/' } }));
  assert.deepEqual(response, { id: 7, result: { method: 'list_directory', params: { path: '/' } } });
});

test('agent bridge rejects an invalid token without calling the handler', async (t) => {
  let called = false;
  const bridge = new AgentBridge(async () => { called = true; return {}; });
  await bridge.start();
  t.after(() => bridge.dispose());
  const response = await send(bridge.endpoint, JSON.stringify({ id: 1, token: 'wrong', method: 'get_session', params: {} }));
  assert.equal(response.error, 'Access denied.');
  assert.equal(called, false);
});

test('agent bridge rejects malformed JSON', async (t) => {
  const bridge = new AgentBridge(async () => ({}));
  await bridge.start();
  t.after(() => bridge.dispose());
  const response = await send(bridge.endpoint, '{');
  assert.match(response.error, /JSON|property|position/i);
});

test('revoking the bridge closes clients with an in-flight request', async (t) => {
  let finish;
  const bridge = new AgentBridge(() => new Promise((resolve) => { finish = resolve; }));
  await bridge.start();
  t.after(() => bridge.dispose());
  const socket = net.createConnection(bridge.endpoint);
  await once(socket, 'connect');
  socket.write(`${JSON.stringify({ id: 1, token: bridge.token, method: 'read_file', params: {} })}\n`);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const closed = once(socket, 'close');
  bridge.dispose();
  finish('secret contents');
  await closed;
  assert.equal(socket.destroyed, true);
});
