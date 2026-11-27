import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { MCP_CONTEXT, MCP_OPEN, MCP_READ, MCP_UI_URI } from '../src/mcp-contract.ts';
import { createHttpMcpServer, HTTP_MCP_BODY_LIMIT, HTTP_MCP_HOST, HTTP_MCP_TYPE } from '../src/server/mcp-http.ts';

const token = 'a'.repeat(64);
const headers = {
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json, text/event-stream',
  'Content-Type': 'application/json',
};
const thread = '00000000-0000-0000-0000-000000000001';

async function listen(context: TestContext, options: Partial<Parameters<typeof createHttpMcpServer>[0]> = {}) {
  const http = createHttpMcpServer({ codexHome: '', token, readHtml: async () => '<html>fixture</html>', ...options });
  await new Promise<void>((resolve, reject) => {
    http.server.once('error', reject);
    http.server.listen(0, HTTP_MCP_HOST, resolve);
  });
  context.after(http.stop);
  const address = http.server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://${HTTP_MCP_HOST}:${address.port}`;
  return { endpoint, port: address.port };
}

async function rpc(endpoint: string, method: string, params: object = {}, signal?: AbortSignal) {
  const response = await fetch(endpoint + '/mcp', {
    method: 'POST', headers, signal,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('mcp-session-id'), null);
  const body = await response.json();
  assert.equal(body.error, undefined);
  return body.result;
}

test('HTTP MCP preserves the native UI contract and routes thread context per call', async context => {
  const { endpoint } = await listen(context);
  const catalog = await rpc(endpoint, 'tools/list');
  assert.deepEqual(catalog.tools.find((tool: { name: string }) => tool.name === MCP_OPEN)?._meta['openai/ui'],
    { entrypoints: [{ type: 'thread' }] });
  assert.equal((await rpc(endpoint, 'resources/read', { uri: MCP_UI_URI })).contents[0].text, '<html>fixture</html>');
  const first = await rpc(endpoint, 'tools/call', { name: MCP_CONTEXT, _meta: { threadId: thread } });
  assert.deepEqual(first._meta.trajectoryContext, { mode: 'host-thread', sessionId: thread });
  const next = await rpc(endpoint, 'tools/call', { name: MCP_CONTEXT });
  assert.deepEqual(next._meta.trajectoryContext, { mode: 'choose-session', reason: 'missing' });
});

test('loopback HTTP MCP rejects incorrect credentials, a spoofed Host, Origin and oversized bodies', async context => {
  const { endpoint, port } = await listen(context);
  const method = 'POST';
  const body = '{}';
  assert.equal((await fetch(endpoint + '/mcp', { method, headers: { ...headers, Authorization: 'Bearer bad' }, body })).status, 401);
  assert.equal((await fetch(endpoint + '/mcp', { method, headers: { ...headers, Origin: 'https://example.test' }, body })).status, 403);
  assert.equal((await fetch(endpoint + '/mcp', { method, headers, body: 'x'.repeat(HTTP_MCP_BODY_LIMIT + 1) })).status, 413);
  assert.equal((await fetch(endpoint + '/mcp', { method, headers, body: '{' })).status, 400);
  assert.equal((await fetch(endpoint + '/mcp', { headers })).status, 405);
  const post = (extra: Record<string, string>, chunks: string[]) => new Promise<number | undefined>((resolve, reject) => {
    const req = request({ host: HTTP_MCP_HOST, port, path: '/mcp', method, headers: { ...headers, ...extra } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
  assert.equal(await post({ Host: 'example.test' }, ['{}']), 403);
  assert.equal(await post({}, ['x'.repeat(HTTP_MCP_BODY_LIMIT / 2), 'y'.repeat(HTTP_MCP_BODY_LIMIT / 2 + 1)]), 413);
  const status = await fetch(endpoint + '/status', { headers });
  assert.deepEqual(await status.json(), { type: HTTP_MCP_TYPE, pid: process.pid });
});

test('canceling one HTTP read delivers an abort signal without canceling another chat', { timeout: 5000 }, async context => {
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const otherStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { endpoint } = await listen(context, {
    read: async (url, signal) => {
      assert.ok(signal);
      if (url.searchParams.get('q') === 'first') {
        signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        started.resolve();
        await aborted.promise;
        signal.throwIfAborted();
      }
      otherStarted.resolve();
      await release.promise;
      signal.throwIfAborted();
      return 'second survived';
    },
  });
  const requestAbort = new AbortController();
  const first = rpc(endpoint, 'tools/call', { name: MCP_READ, arguments: { path: '/api/sessions?q=first' }, _meta: { threadId: thread } }, requestAbort.signal);
  const cancel = assert.rejects(first, { name: 'AbortError' });
  await started.promise;
  const second = rpc(endpoint, 'tools/call', {
    name: MCP_READ, arguments: { path: '/api/sessions?q=second' },
    _meta: { threadId: '00000000-0000-0000-0000-000000000002' },
  });
  await otherStarted.promise;
  requestAbort.abort();
  await cancel;
  await aborted.promise;
  release.resolve();
  assert.deepEqual((await second)._meta.trajectoryResponse, { data: 'second survived' });
});
