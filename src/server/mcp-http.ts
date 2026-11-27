import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createTrajectoryApi } from './api.ts';
import { createMcpBridge } from './mcp-bridge.ts';

export const HTTP_MCP_HOST = '127.0.0.1';
export const HTTP_MCP_PORT = 4381;
export const HTTP_MCP_BODY_LIMIT = 64 * 1024;
export const HTTP_MCP_TYPE = 'codex-trajectory-http-v1';

interface Options {
  codexHome: string;
  token: string;
  readHtml: () => Promise<string>;
  read?: ReturnType<typeof createTrajectoryApi>;
}

class InvalidBody extends Error {
  status: number;

  constructor(status: number) {
    super('Invalid HTTP MCP body');
    this.status = status;
  }
}

function readJson(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers['content-length']) > HTTP_MCP_BODY_LIMIT) {
    return Promise.reject(new InvalidBody(413));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= HTTP_MCP_BODY_LIMIT) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      reject(new InvalidBody(413));
    });
    request.once('end', () => {
      if (size > HTTP_MCP_BODY_LIMIT) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new InvalidBody(400));
      }
    });
    request.once('error', reject);
  });
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

export function createHttpMcpServer({ codexHome, token, readHtml, read = createTrajectoryApi(codexHome) }: Options) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid HTTP MCP token');
  const authorization = Buffer.from(`Bearer ${token}`);
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    void handle(request, response).catch(error => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof InvalidBody) response.setHeader('Connection', 'close');
      json(response, error instanceof InvalidBody ? error.status : 500, { error: 'HTTP MCP request failed' });
    });
  });
  let stopping: Promise<void> | undefined;

  function stop() {
    stopping ??= new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => server.closeAllConnections(), 5000);
      deadline.unref();
      server.close(error => {
        clearTimeout(deadline);
        if (error) reject(error);
        else resolve();
      });
    });
    return stopping;
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const bound = server.address();
    const host = bound && typeof bound === 'object' ? `${HTTP_MCP_HOST}:${bound.port}` : '';
    if (request.headers.host !== host || request.headers.origin !== undefined) {
      json(response, 403, { error: 'Host or Origin is not allowed' });
      return;
    }
    const received = Buffer.from(request.headers.authorization ?? '');
    if (received.length !== authorization.length || !timingSafeEqual(received, authorization)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      json(response, 401, { error: 'Authentication required' });
      return;
    }
    if (request.url === '/status' && request.method === 'GET') {
      json(response, 200, { type: HTTP_MCP_TYPE, pid: process.pid });
      return;
    }
    if (request.url === '/stop' && request.method === 'POST') {
      response.setHeader('Connection', 'close');
      json(response, 200, { type: HTTP_MCP_TYPE });
      await stop();
      return;
    }
    if (request.url !== '/mcp') {
      json(response, 404, { error: 'Resource not found' });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      json(response, 405, { error: 'Method not allowed' });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
      json(response, 415, { error: 'Expected an application/json body' });
      return;
    }

    const body = await readJson(request);
    if (response.destroyed) return;
    const abort = new AbortController();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });
    const bridge = createMcpBridge(codexHome, readHtml, read, abort.signal);
    response.once('close', () => {
      if (!response.writableFinished) abort.abort();
      void bridge.close().catch(() => {});
    });
    try {
      await bridge.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      await bridge.close();
      throw error;
    }
  }

  return { server, stop };
}
