import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MCP_CONTEXT, MCP_OPEN, MCP_READ, MCP_SETTINGS, MCP_SHOW, MCP_UI_MIME, MCP_UI_URI } from '../src/mcp-contract.ts';
import { createTrajectoryApi } from '../src/server/api.ts';
import { callingThread, createMcpBridge } from '../src/server/mcp-bridge.ts';

const session = '00000000-0000-0000-0000-0000000000a1';
const other = '00000000-0000-0000-0000-0000000000a2';
const fixturePrivateOutput = 'fixture: visibility of a tool result';
const testHtml = '<!doctype html><html><body>test panel</body></html>';

test('the portable Desktop manifest uses only fields supported by its stdio loader', async () => {
  const manifest = JSON.parse(await readFile(new URL('../desktop/mcp.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.mcpServers['local-trajectory-viewer'], {
    type: 'stdio',
    command: 'node',
    args: ['${PLUGIN_ROOT}/server.mjs'],
    cwd: '${PLUGIN_ROOT}',
  });
});

test('thread binding trusts only explicit, valid and agreeing host metadata', () => {
  assert.deepEqual(callingThread({ threadId: session.toUpperCase(), thread_id: session }), { mode: 'host-thread', sessionId: session });
  assert.deepEqual(callingThread({ 'openai/session': session, sessionId: session }), { mode: 'choose-session', reason: 'missing' });
  assert.deepEqual(callingThread({ threadId: session, thread_id: other }), { mode: 'choose-session', reason: 'invalid' });
  assert.deepEqual(callingThread({ threadId: '../../session.jsonl' }), { mode: 'choose-session', reason: 'invalid' });
});

test('MCP SDK discovers the native UI resource and returns only opening text without session content', async context => {
  // A nonexistent filesystem root verifies that opening is independent of log resolution.
  const server = createMcpBridge(join(tmpdir(), 'trajectory-m3-unresolved-root'), async () => testHtml);
  const client = new Client({ name: 'panel-test', version: '1.0.0' });
  const [view, host] = InMemoryTransport.createLinkedPair();
  await server.connect(host);
  await client.connect(view);
  context.after(async () => { await client.close(); await server.close(); });

  const available = await client.listTools();
  const opener = available.tools.find(tool => tool.name === MCP_OPEN)!;
  assert.deepEqual(opener._meta?.['openai/ui'], { entrypoints: [{ type: 'thread' }] });
  assert.deepEqual(opener._meta?.ui, { resourceUri: MCP_UI_URI, visibility: ['app'] });
  assert.deepEqual(available.tools.find(tool => tool.name === MCP_READ)?._meta?.ui, { visibility: ['app'] });
  assert.deepEqual(available.tools.find(tool => tool.name === MCP_SETTINGS)?._meta?.ui, { visibility: ['app'] });
  assert.deepEqual((await client.listResources()).resources.map(entry => [entry.uri, entry.mimeType]), [[MCP_UI_URI, MCP_UI_MIME]]);
  const resource = (await client.readResource({ uri: MCP_UI_URI })).contents[0];
  assert.ok('text' in resource);
  assert.equal(resource.text, testHtml);
  assert.deepEqual(resource._meta?.ui, { prefersBorder: false });
  await assert.rejects(client.readResource({ uri: 'file:///local-secret' }));

  const opened = await client.callTool({ name: MCP_OPEN, arguments: {}, _meta: { threadId: session } }) as CallToolResult;
  assert.equal(opened.structuredContent, undefined);
  assert.deepEqual(opened._meta?.trajectoryContext, { mode: 'host-thread', sessionId: session });
  assert.ok(!JSON.stringify(opened.content).includes(session));
  const missing = await client.callTool({ name: MCP_SHOW, arguments: {} }) as CallToolResult;
  assert.deepEqual(missing._meta?.trajectoryContext, { mode: 'choose-session', reason: 'missing' });
  const bootstrap = await client.callTool({ name: MCP_CONTEXT, arguments: {}, _meta: { threadId: session } }) as CallToolResult;
  assert.deepEqual(bootstrap._meta?.trajectoryContext, opened._meta?.trajectoryContext);
  await assert.rejects(client.callTool({ name: MCP_SHOW, arguments: { sessionId: session } }));
});

test('settings are shared across panels while only the declared preferences can be saved', async context => {
  const home = await mkdtemp(join(tmpdir(), 'trajectory-settings-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const connect = async () => {
    const server = createMcpBridge(home, async () => testHtml);
    const client = new Client({ name: 'panel-test', version: '1.0.0' });
    const [view, host] = InMemoryTransport.createLinkedPair();
    await server.connect(host);
    await client.connect(view);
    context.after(async () => { await client.close(); await server.close(); });
    return async (args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name: MCP_SETTINGS, arguments: args }) as CallToolResult;
      return result._meta?.trajectoryResponse;
    };
  };
  const [first, second] = await Promise.all([connect(), connect()]);
  assert.deepEqual(await first(), { data: { foldTools: true, keepLatestOpen: true, loadAll: true } });
  assert.deepEqual(await Promise.all([
    first({ key: 'foldTools', value: false }), second({ key: 'loadAll', value: false }),
  ]), [{ data: null }, { data: null }]);
  assert.deepEqual(await second(), { data: { foldTools: false, keepLatestOpen: true, loadAll: false } });
  assert.deepEqual(await first({ key: '../config.toml', value: true }), { error: '无效的查看器设置。' });
});

test('panel reads the same summaries and detailed sources through app-only private metadata', async context => {
  const home = await mkdtemp(join(tmpdir(), 'trajectory-m3-'));
  const dir = join(home, 'sessions', '2026', '11', '27');
  await mkdir(dir, { recursive: true });
  const row = JSON.stringify({ type: 'response_item', payload: {
    type: 'function_call', name: 'synthetic_tool', call_id: 'synthetic-call', arguments: fixturePrivateOutput,
  } });
  await writeFile(join(dir, `rollout-2026-11-27T10-11-12-${session}.jsonl`), row + '\n');
  const server = createMcpBridge(home, async () => testHtml);
  const client = new Client({ name: 'panel-test', version: '1.0.0' });
  const [view, host] = InMemoryTransport.createLinkedPair();
  await server.connect(host);
  await client.connect(view);
  context.after(async () => { await client.close(); await server.close(); await rm(home, { recursive: true, force: true }); });
  const read = async (path: string) => await client.callTool({ name: MCP_READ, arguments: { path } }) as CallToolResult;
  const path = '/api/sessions/' + session;
  const calls = createTrajectoryApi(home);
  const standalone = await calls(new URL(path, 'http://127.0.0.1')) as { events: Array<{ source: { offset: number; length: number; digest: string } }> };
  const panel = await read(path);
  assert.deepEqual(panel._meta?.trajectoryResponse, { data: standalone });
  assert.equal(panel.structuredContent, undefined);
  assert.ok(!JSON.stringify(panel.content).includes(fixturePrivateOutput));
  const source = standalone.events[0].source;
  const meta = await calls(new URL(path + '/meta', 'http://127.0.0.1'));
  assert.deepEqual(meta, {
    id: session, name: null, kind: 'thread', parentId: null, agentPath: null, agentRole: null,
    date: '2026-11-27T10-11-12', archived: false,
  });
  const panelMeta = await read(path + '/meta');
  assert.deepEqual(panelMeta._meta?.trajectoryResponse, { data: meta });
  const query = new URLSearchParams({ offset: String(source.offset), length: String(source.length), from: '0', digest: source.digest, field: 'content' });
  const detail = await read(`${path}/detail?${query}`);
  assert.deepEqual(detail._meta?.trajectoryResponse, { data: { text: fixturePrivateOutput, next: null } });
  assert.ok(!JSON.stringify(detail.content).includes(fixturePrivateOutput));
  assert.deepEqual((await read('/api/sessions/' + other))._meta?.trajectoryResponse, { error: '找不到指定会话。' });
  await assert.rejects(read('https://127.0.0.1/api/sessions'));
  await assert.rejects(read('/api/sessions\\..\\..\\secret'));
});
