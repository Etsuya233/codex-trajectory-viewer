import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const codex = process.argv[2] || 'codex';
const bundle = resolve(process.argv[3] || 'dist/desktop-marketplace/plugins/local-trajectory-viewer');
const root = await mkdtemp(join(await realpath(tmpdir()), 'trajectory-http-verify-'));
const portable = join(root, 'bundle');
const home = join(root, 'codex');
const state = join(root, 'private');
const session = '00000000-0000-0000-0000-0000000000a1';
const serverName = 'local_trajectory_http';
const children = new Set();
const exec = promisify(execFile);
const excluded = /^(CODEX_|OPENAI_|TRAJECTORY_HTTP_)|API_KEY/i;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.test(key)));
const options = { cwd: root, env, windowsHide: true };
const program = join(portable, 'http-server.mjs');
let app;
let worker;
let sequence = 0;
const pending = new Map();
const closed = new Set();

function child(command, args) {
  const process = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(process);
  process.once('close', () => children.delete(process));
  return process;
}

async function until(check, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(50);
  }
  throw new Error(message);
}

async function getPort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function backend(command) {
  return (await exec(process.execPath, [program, command], { ...options, timeout: 8_000 })).stdout.trim();
}

async function start() {
  const process = child(globalThis.process.execPath, [program, 'start']);
  let stderr = '';
  let output = '';
  process.stdout.on('data', chunk => { output += chunk; });
  process.stderr.on('data', chunk => { stderr += chunk; });
  await until(() => {
    if (process.exitCode !== null) throw new Error('Backend failed to start: ' + stderr.trim());
    return output.includes('listening at');
  }, 'Backend did not become ready');
  assert.match(await backend('status'), new RegExp('PID ' + process.pid + '\\)$'));
  return process;
}

async function stop() {
  assert.equal(await backend('stop'), 'Trajectory HTTP MCP stopping.');
  await until(() => worker.exitCode !== null, 'Backend did not stop');
  assert.equal(worker.exitCode, 0);
}

async function request(method, params) {
  const id = ++sequence;
  const answer = Promise.withResolvers();
  pending.set(id, answer);
  app.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  const abort = AbortSignal.timeout(20_000);
  try {
    return await Promise.race([answer.promise, new Promise((_, reject) => {
      abort.addEventListener('abort', () => reject(new Error('Timed out: ' + method)), { once: true });
    })]);
  } finally {
    pending.delete(id);
  }
}

function notification(method) {
  app.stdin.write(JSON.stringify({ method }) + '\n');
}

function tool(threadId, tool, args = {}) {
  return request('mcpServer/tool/call', { threadId, server: serverName, tool, arguments: args });
}

async function trajectory(thread) {
  const response = await tool(thread, 'local_trajectory_read', { path: '/api/sessions/' + session + '?around=0' });
  const data = response._meta?.trajectoryResponse?.data;
  assert.ok(data?.generation, 'Expected a fully built synthetic index');
  return data.generation;
}

try {
  await cp(bundle, portable, { recursive: true });
  await mkdir(home);
  Object.assign(env, {
    CODEX_HOME: home,
    TRAJECTORY_HTTP_PORT: String(await getPort()),
    TRAJECTORY_HTTP_STATE_DIR: state,
  });
  const config = await backend('config');
  assert.equal(config, join(state, 'codex-http-mcp.toml'));
  const snippet = await readFile(config, 'utf8');
  assert.equal(await backend('config'), config);
  assert.equal(await readFile(config, 'utf8'), snippet, 'config must retain the same token');
  await writeFile(join(home, 'config.toml'), 'thread_unload_delay_secs = 2\n' + snippet, { mode: 0o600 });
  const folder = join(home, 'sessions', '2026', '11', '27');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'rollout-2026-11-27T10-11-12-' + session + '.jsonl'), JSON.stringify({
    type: 'response_item', payload: { type: 'function_call', name: 'synthetic_fixture', call_id: 'sample', arguments: '{}' },
  }) + '\n');

  worker = await start();
  const firstPid = worker.pid;
  await assert.rejects(backend('start'), /already in use/);

  app = child(codex, [
    'app-server', '--stdio', '-c', 'model_provider=trajectory_probe_local',
    '-c', 'model_providers.trajectory_probe_local.name=TrajectoryProbe',
    '-c', 'model_providers.trajectory_probe_local.base_url=http://127.0.0.1:1',
    '-c', 'model_providers.trajectory_probe_local.supports_websockets=false',
  ]);
  app.stderr.resume();
  app.once('error', error => { for (const reply of pending.values()) reply.reject(error); });
  app.once('exit', code => { for (const reply of pending.values()) reply.reject(new Error('app-server exited: ' + code)); });
  const lines = createInterface({ input: app.stdout });
  lines.on('line', line => {
    const packet = JSON.parse(line);
    if (packet.method === 'thread/closed') closed.add(packet.params.threadId);
    const reply = pending.get(packet.id);
    if (reply && !packet.method) {
      if (packet.error) reply.reject(new Error(packet.error.message));
      else reply.resolve(packet.result);
    } else if (packet.method && packet.id !== undefined) {
      app.stdin.write(JSON.stringify({ id: packet.id, error: { code: -32601, message: 'No reverse requests' } }) + '\n');
    }
  });
  const init = await request('initialize', { clientInfo: { name: 'trajectory-http-verification', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  assert.equal(init.codexHome.toLowerCase(), home.toLowerCase());
  notification('initialized');
  const thread = async () => (await request('thread/start', { cwd: root, ephemeral: true, approvalPolicy: 'never' })).thread.id;
  const a = await thread();
  const b = await thread();
  const [aContext, bContext] = await Promise.all([a, b].map(async id => {
    const response = await tool(id, 'local_trajectory_context');
    return response._meta?.trajectoryContext;
  }));
  assert.equal(aContext?.sessionId, a);
  assert.equal(bContext?.sessionId, b);
  const [aIndex, bIndex] = await Promise.all([trajectory(a), trajectory(b)]);
  assert.equal(aIndex, bIndex, 'Both threads must use one IndexStore generation');
  const catalog = await request('mcpServerStatus/list', { threadId: a });
  const server = catalog.data.find(server => server.name === serverName);
  const entry = Object.values(server.tools).find(tool => tool._meta?.['openai/ui']);
  assert.deepEqual(entry._meta['openai/ui'].entrypoints, [{ type: 'thread' }]);
  const resource = await request('mcpServer/resource/read', {
    threadId: a, server: serverName, uri: entry._meta.ui.resourceUri,
  });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(resource.contents[0].text, /trajectory-transport/);
  console.log('Two ephemeral threads shared PID %d and one index generation, with independent thread IDs, UI metadata and panel HTML.', firstPid);
  assert.equal((await request('thread/unsubscribe', { threadId: a })).status, 'unsubscribed');
  await until(() => closed.has(a), 'A did not unload');
  assert.equal(await trajectory(b), bIndex);
  await stop();
  await assert.rejects(trajectory(b), /tool call failed|HTTP request failed/);
  worker = await start();
  assert.notEqual(worker.pid, firstPid);
  assert.notEqual(await trajectory(b), bIndex);
  console.log('A unloaded, B kept its index. After a failed call during downtime, B reused the same app-server thread against replacement PID %d.', worker.pid);
  await stop();
  app.stdin.end();
  await until(() => app.exitCode !== null, 'app-server did not exit');
  assert.equal(app.exitCode, 0);
} finally {
  for (const process of children) {
    if (process.exitCode === null && process.signalCode === null) process.kill();
  }
  await until(() => children.size === 0, 'Verification child processes did not exit').catch(() => {});
  assert.equal(await realpath(root), root);
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
