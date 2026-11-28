import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSession } from '../src/server/rollout.ts';
import { readDetail, readRecent, RequestError } from '../src/server/session.ts';
import { createTrajectoryApi } from '../src/server/api.ts';

const sessionId = '00000000-0000-0000-0000-000000000001';
const otherId = '00000000-0000-0000-0000-000000000002';
const turnId = '00000000-0000-0000-0000-000000000010';
const stamp = '2026-02-03T04:05:06Z';

function item(type: string, properties: Record<string, unknown>) {
  return JSON.stringify({ timestamp: stamp, type: 'response_item', payload: { type, ...properties } });
}

function marker(type: string) {
  return JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type, turn_id: turnId } });
}

function call(id: string, input: string) {
  return item('custom_tool_call', { call_id: id, name: 'shell', input });
}

async function fixture(lines: string[], tail = '') {
  const home = await mkdtemp(join(tmpdir(), 'trajectory-test-'));
  const sessionDir = join(home, 'sessions', '2026', '02', '03');
  await mkdir(sessionDir, { recursive: true });
  const path = join(sessionDir, `rollout-2026-02-03T04-05-06-${sessionId}.jsonl`);
  await writeFile(path, lines.map(line => line + '\r\n').join('') + tail);
  return { home, path, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test('locates the named session including archived sessions and rejects invalid IDs', async context => {
  const { home, path, cleanup } = await fixture([]);
  context.after(cleanup);
  const archive = join(home, 'archived_sessions');
  await mkdir(archive);
  const archivePath = join(archive, `rollout-2026-02-03T04-05-06-${otherId}.jsonl`);
  await writeFile(archivePath, 'archived');
  assert.equal(await findSession(home, sessionId), path);
  assert.equal(await findSession(home, otherId), archivePath);
  await assert.rejects(findSession(home, '../wrong'), (error: RequestError) => error.status === 400);
  await assert.rejects(findSession(home, turnId), (error: RequestError) => error.status === 404);
});

test('pairs interleaved calls by ID and keeps explicit failure, running and missing states distinct', async context => {
  const { path, cleanup } = await fixture([
    marker('task_started'),
    call('a', 'first'),
    call('b', 'second'),
    item('custom_tool_call_output', { call_id: 'b', output: { exit_code: 9 } }),
    call('c', 'missing'),
    item('custom_tool_call_output', { call_id: 'a',
      output: [{ type: 'input_text', text: 'Chunk ID: aa\nProcess running with session ID 9\nOutput:\nstarted' }] }),
    item('function_call_output', { call_id: 'outside', output: 'orphan response' }),
    marker('task_complete'),
  ]);
  context.after(cleanup);
  const result = await readRecent(path);
  assert.deepEqual(result.events.map(row => [row.callId, row.kind, row.result?.status, row.turn]), [
    ['a', 'tool', 'running', turnId],
    ['b', 'tool', 'error', turnId],
    ['c', 'tool', undefined, turnId],
    ['outside', 'result', 'returned', turnId],
  ]);
  assert.equal((await readDetail(path, result.events[1].source, 'content', 0)).text, 'second');
  assert.equal(JSON.parse((await readDetail(path, result.events[1].result!.source, 'content', 0)).text).exit_code, 9);
});

test('reads multi-chunk UTF-8 lines, pages detail without splitting a surrogate pair, and waits for a partial line', async context => {
  const long = 'A'.repeat(32767) + '🧭' + '摄'.repeat(50000);
  const tail = item('reasoning', { summary: [{ type: 'summary_text', text: '已有摘要' }], encrypted_content: 'opaque' });
  const { path, cleanup } = await fixture([call('long', long), '{bad json'], tail);
  context.after(cleanup);

  const rows = (await readRecent(path)).events;
  assert.deepEqual(rows.map(row => row.kind), ['tool', 'unknown']);
  assert.equal(rows[0].source.offset, 0);
  assert.ok(rows[0].preview.length < 200);
  const pages = [];
  let from: number | null = 0;
  while (from !== null) {
    const page = await readDetail(path, rows[0].source, 'content', from);
    assert.ok(!/[\uD800-\uDBFF]$/.test(page.text));
    pages.push(page.text);
    from = page.next;
  }
  assert.equal(pages.join(''), long);
  assert.equal((await readDetail(path, rows[1].source, 'raw', 0)).text, '{bad json');
  await appendFile(path, '\n');
  const reasoning = (await readRecent(path)).events.at(-1)!;
  assert.equal(reasoning.kind, 'reasoning');
  assert.equal((await readDetail(path, reasoning.source, 'content', 0)).text, '已有摘要');
});

test('formats shell input and multipart tool output before truncation and retains the original fields', async context => {
  const script = '$env:CODEX_EXAMPLE = "ok"\ngit commit -m "fixture"';
  const argv = [`C:\\Program Files\\${'long-path-'.repeat(25)}\\pwsh.exe`, '-NoProfile', '-Command', script];
  const stdout = 'Output:\n[main 0e4386d] fixture\n';
  const shellRecord = JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'CommandExecution', id: 'shell-v2', command: argv, status: 'completed', exit_code: 0, aggregated_output: stdout,
  } } });
  const js = 'await tools.exec_command({ cmd: "git add -- README.md" })';
  const blocks = [
    { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
    { type: 'input_text', text: 'README.md | 1 +' },
    { type: 'input_text', text: '1 file changed' },
  ];
  const legacyInput = JSON.stringify({ cmd: 'git add -- README.md', workdir: '/fixture' });
  const { path, home, cleanup } = await fixture([
    shellRecord,
    item('custom_tool_call', { call_id: 'wrapper', name: 'exec', input: js }),
    item('custom_tool_call_output', { call_id: 'wrapper', output: blocks }),
    item('function_call', { call_id: 'legacy', name: 'exec_command', arguments: legacyInput }),
    item('function_call_output', { call_id: 'legacy', output: 'Chunk ID: 1\nWall time: 0.1 seconds\nOutput:\n' }),
  ]);
  context.after(cleanup);
  const api = createTrajectoryApi(home);
  const [shell, outer, legacy] = (await readRecent(path)).events;
  const detail = async (source: typeof shell.source, field: string) => {
    const url = new URL(`/api/sessions/${sessionId}/detail`, 'http://localhost');
    url.search = new URLSearchParams({ offset: String(source.offset), length: String(source.length), digest: source.digest, field, from: '0' }).toString();
    return (await api(url) as { text: string }).text;
  };
  assert.equal(shell.preview, '$env:CODEX_EXAMPLE = "ok" git commit -m "fixture"');
  assert.equal(await detail(shell.source, 'input'), script);
  assert.equal(await detail(shell.source, 'output'), stdout);
  assert.deepEqual(JSON.parse(await detail(shell.source, 'raw-input')), argv);
  assert.equal(await detail(shell.source, 'raw-output'), stdout);
  assert.equal(await detail(shell.source, 'raw'), shellRecord);
  assert.equal(await detail(outer.source, 'input'), js);
  assert.equal(outer.result?.preview, 'README.md | 1 + 1 file changed');
  assert.equal(await detail(outer.result!.source, 'output'), 'README.md | 1 +\n\n1 file changed');
  assert.deepEqual(JSON.parse(await detail(outer.result!.source, 'raw-output')), blocks);
  assert.equal(legacy.preview, 'git add -- README.md');
  assert.equal(await detail(legacy.source, 'raw-input'), legacyInput);
  assert.equal(await detail(legacy.result!.source, 'output'), '');
  assert.equal(legacy.result?.outputMissing, undefined);
});

test('limits the initial ledger and preserves a result whose call is outside it', async context => {
  const { path, cleanup } = await fixture([
    marker('task_started'),
    call('older', 'outside the recent page'),
    ...Array.from({ length: 50 }, (_, index) => call(`n-${index}`, 'recent')),
    item('custom_tool_call_output', { call_id: 'older', output: 'late result' }),
  ]);
  context.after(cleanup);
  const page = await readRecent(path);
  assert.equal(page.events.length, 50);
  assert.equal(page.earlier, true);
  assert.equal(page.scanLimited, false);
  assert.equal(page.events.at(-1)?.kind, 'result');
  assert.ok(page.events.every(row => row.turn === turnId));
});

test('marks scan limit and omits huge content while preserving newer complete records', async context => {
  const { path, cleanup } = await fixture([call('big', 'x'.repeat(9 * 1024 * 1024)), call('small', 'recent')]);
  context.after(cleanup);
  const page = await readRecent(path);
  assert.deepEqual(page.events.map(event => event.callId), ['small']);
  assert.equal(page.earlier, true);
  assert.equal(page.scanLimited, true);
});

test('rejects stale detail offsets when a line has changed', async context => {
  const { path, cleanup } = await fixture([call('a', 'original')]);
  context.after(cleanup);
  const source = (await readRecent(path)).events[0].source;
  await writeFile(path, call('a', 'replaced') + '\r\n');
  await assert.rejects(readDetail(path, source, 'content', 0), (error: RequestError) => error.status === 409);
});
