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
  description: 'Return MCP availability, FTP connection and authorization status, granted capabilities, and access limits. connected describes the MCP bridge; remoteConnected describes FTP.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true }
}, () => toolCall('get_session', {}));

server.registerTool('list_directory', {
  description: 'List entries within the FTP root explicitly granted by the user in VS Code. Paths are relative to that root.',
  inputSchema: sessionInput.extend({ path: z.string().default('/'), limit: z.number().int().min(1).max(1000).default(200) }).strict(),
  annotations: { readOnlyHint: true }
}, ({ sessionId, path, limit }) => toolCall('list_directory', { sessionId, path, limit }));

server.registerTool('list_remote_directory', {
  description: 'List direct entries in a granted FTP directory without reading file contents; omit path for the open remote pane. Paths are relative to the granted FTP root.',
  inputSchema: sessionInput.extend({ path: z.string().min(1).optional() }).strict(),
  annotations: { readOnlyHint: true }
}, (params) => toolCall('list_remote_directory', params));

server.registerTool('select_remote_files', {
  description: 'Replace the selection in the open remote pane by exact basenames or a case-insensitive basename substring. Does not read file contents; clears the pane name filter.',
  inputSchema: sessionInput.extend({ path: z.string().min(1).optional(), names: z.array(z.string().min(1).max(255)).min(1).max(1000).optional(), nameContains: z.string().min(1).max(255).optional(), includeDirectories: z.boolean().default(false) }).strict().refine((value) => (value.names !== undefined) !== (value.nameContains !== undefined), 'Provide either names or nameContains.'),
  annotations: { readOnlyHint: false, destructiveHint: false }
}, (params) => toolCall('select_remote_files', params));

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

server.registerTool('get_local_pane', {
  description: 'Get the local pane path and revision, within the separately granted local root.',
  inputSchema: sessionInput,
  annotations: { readOnlyHint: true }
}, (params) => toolCall('get_local_pane', params));

server.registerTool('list_local_directory', {
  description: 'List direct local directory entries without reading contents or following symbolic links. Paths in the result are relative to the granted local root; omit path for the open pane.',
  inputSchema: sessionInput.extend({ path: z.string().min(1).optional() }).strict(),
  annotations: { readOnlyHint: true }
}, (params) => toolCall('list_local_directory', params));

server.registerTool('select_local_files', {
  description: 'Replace the selection in the open local pane by exact basenames or a case-insensitive basename substring. Does not read file contents; clears the pane name filter.',
  inputSchema: sessionInput.extend({ path: z.string().min(1).optional(), names: z.array(z.string().min(1).max(255)).min(1).max(1000).optional(), nameContains: z.string().min(1).max(255).optional(), includeDirectories: z.boolean().default(false) }).strict().refine((value) => (value.names !== undefined) !== (value.nameContains !== undefined), 'Provide either names or nameContains.'),
  annotations: { readOnlyHint: false, destructiveHint: false }
}, (params) => toolCall('select_local_files', params));

server.registerTool('find_local_directories', {
  description: 'Find directory names within the separately granted local root; symbolic links are not followed.',
  inputSchema: sessionInput.extend({ nameQuery: z.string().min(1).max(200), maxDepth: z.number().int().min(0).max(8).default(5), maxResults: z.number().int().min(1).max(200).default(100) }).strict(),
  annotations: { readOnlyHint: true }
}, (params) => toolCall('find_local_directories', params));

server.registerTool('navigate_local', {
  description: 'Navigate the local pane to a directory within the separately granted local root. This changes the visible pane.',
  inputSchema: sessionInput.extend({ path: z.string().min(1) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false }
}, (params) => toolCall('navigate_local', params));

server.registerTool('search_local_text_and_select', {
  description: 'Search text in files directly in the open local folder and select matching visible files. This changes the pane selection and clears its name filter.',
  inputSchema: sessionInput.extend({ text: z.string().min(1).max(500), caseSensitive: z.boolean().default(false) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false }
}, (params) => toolCall('search_local_text_and_select', params));

server.registerTool('read_local_file', {
  description: 'Read bounded UTF-8 text from a non-sensitive file under the separately granted local root.',
  inputSchema: sessionInput.extend({ path: z.string().min(1), startLine: z.number().int().min(1).default(1), maxLines: z.number().int().min(1).max(400).default(200) }).strict(),
  annotations: { readOnlyHint: true }
}, (params) => toolCall('read_local_file', params));

await serveStdio(() => server);
