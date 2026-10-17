import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { findGrantedBridge } from './registry.mjs';

const directEndpoint = process.env.BM_FTP_AGENT_ENDPOINT;
const directToken = process.env.BM_FTP_AGENT_TOKEN;
const registry = process.env.BM_FTP_AGENT_REGISTRY;
if (!(directEndpoint && directToken) && !registry) throw new Error('Configure bm.ftp as an MCP server or enable its VS Code agent provider.');

let nextId = 0;
async function request(method, params = {}) {
  const credentials = directEndpoint && directToken
    ? { endpoint: directEndpoint, token: directToken }
    : await findGrantedBridge(registry);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(credentials.endpoint);
    let response = '';
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => socket.destroy(new Error('The FTP operation timed out.')), 35_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: ++nextId, token: credentials.token, method, params })}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response, 'utf8') > 2 * 1024 * 1024) {
        socket.destroy(new Error('The response exceeded the configured size limit.'));
        return;
      }
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      try {
        const result = JSON.parse(response.slice(0, newline));
        if (result.error) settle(reject, new Error(result.error));
        else settle(resolve, result.result);
      } catch (error) {
        settle(reject, error);
      } finally {
        socket.end();
      }
    });
    socket.on('error', (error) => {
      settle(reject, error);
    });
    socket.on('close', () => {
      if (!settled) settle(reject, new Error('The FTP bridge closed before returning a response. Access may have been revoked.'));
    });
  });
}

async function toolCall(method, params) {
  try {
    const result = await request(method, params);
    return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The FTP request failed.';
    return { isError: true, content: [{ type: 'text', text: message }] };
  }
}

const server = new McpServer({ name: 'bm.ftp', version: '0.2.0' });
const sessionInput = z.object({ sessionId: z.string().min(1) }).strict();
server.registerTool('get_session', {
  description: 'Return the active FTP session and the access limits granted in VS Code.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true }
}, () => toolCall('get_session', {}));

server.registerTool('list_directory', {
  description: 'List entries within the FTP root explicitly granted by the user in VS Code. Paths are relative to that root.',
  inputSchema: sessionInput.extend({ path: z.string().default('/'), limit: z.number().int().min(1).max(1000).default(200) }).strict(),
  annotations: { readOnlyHint: true }
}, ({ sessionId, path, limit }) => toolCall('list_directory', { sessionId, path, limit }));

server.registerTool('search_files', {
  description: 'Search FTP file and folder names within the granted root. Search does not inspect file contents.',
  inputSchema: sessionInput.extend({ path: z.string().default('/'), nameQuery: z.string().min(1).max(200), recursive: z.boolean().default(true), maxDepth: z.number().int().min(0).max(16).default(8), maxResults: z.number().int().min(1).max(1000).default(100) }).strict(),
  annotations: { readOnlyHint: true }
}, ({ sessionId, ...params }) => toolCall('search_files', { sessionId, ...params }));

server.registerTool('read_file', {
  description: 'Read a bounded UTF-8 text file under the granted FTP root. Sensitive and binary files are blocked.',
  inputSchema: sessionInput.extend({ path: z.string().min(1), startLine: z.number().int().min(1).default(1), maxLines: z.number().int().min(1).max(400).default(200) }).strict(),
  annotations: { readOnlyHint: true }
}, ({ sessionId, ...params }) => toolCall('read_file', { sessionId, ...params }));

await serveStdio(() => server);
