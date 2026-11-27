import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IndexStore } from '../src/server/index.ts';
import { listSessions } from '../src/server/catalog.ts';
import { readDetail } from '../src/server/session.ts';

const parent = '00000000-0000-0000-0000-000000000021';
const child = '00000000-0000-0000-0000-000000000022';
const time = '2026-11-27T10:00:00.000Z';

function row(type: string, payload: Record<string, unknown>, ordinal?: number) {
  return JSON.stringify({ timestamp: time, type, ordinal, payload }) + '\n';
}

function event(type: string, payload: Record<string, unknown> = {}, ordinal?: number) {
  return row('event_msg', { type, ...payload }, ordinal);
}

function item(type: string, payload: Record<string, unknown>) {
  return row('response_item', { type, ...payload });
}

function call(callId: string, name: string, args: string) {
  return item('function_call', { call_id: callId, name, arguments: args });
}

function output(callId: string, value: unknown) {
  return item('function_call_output', { call_id: callId, output: value });
}

function message(text: string) {
  return item('message', { role: 'user', content: [{ type: 'input_text', text }] });
}

async function fixture(contents: string) {
  const home = await mkdtemp(join(tmpdir(), 'codex-viewer-index-'));
  const dir = join(home, 'sessions', '2026', '11', '27');
  await mkdir(dir, { recursive: true });
  const pathFor = (id: string) => join(dir, `rollout-2026-11-27T10-00-00-${id}.jsonl`);
  const path = pathFor(parent);
  await writeFile(path, contents);
  return { home, path, pathFor, store: new IndexStore(home), cleanup: () => rm(home, { recursive: true, force: true }) };
}

test('cold preview yields recent rows, then history traverses the complete index without duplicates', async context => {
  const log = await fixture(event('task_started', { turn_id: 'test-turn' }) +
    Array.from({ length: 163 }, (_, i) => message('message ' + i)).join('') +
    event('task_complete', { turn_id: 'test-turn', duration_ms: 24 }));
  context.after(log.cleanup);
  const cold = await log.store.recent(parent);
  assert.equal(cold.indexing, true);
  assert.equal(cold.events.length, 50);
  const [index, same] = await Promise.all([log.store.indexed(parent), log.store.indexed(parent)]);
  assert.equal(index, same);
  let page = index.page();
  const all = [...page.events];
  while (page.earlier) {
    page = index.page(page.events[0].source.offset);
    all.unshift(...page.events);
  }
  assert.equal(all.length, 163);
  assert.equal(new Set(all.map(record => record.source.offset)).size, all.length);
  assert.equal(all[0].preview, 'message 0');
  assert.equal(all.at(-1)?.preview, 'message 162');
  const anchor = all[41].source.offset;
  assert.ok(index.page(undefined, anchor).events.some(record => record.source.offset === anchor));
  assert.equal(index.page(undefined, undefined, anchor).events[0].preview, 'message 42');
  assert.equal((await log.store.recent(parent)).indexing, false);
});

test('assigns stable 1-based ordinals to turns while indexing', async context => {
  const log = await fixture(
    event('task_started', { turn_id: 'first-turn' })
    + message('first turn message')
    + event('task_complete', { turn_id: 'first-turn' })
    + event('task_started', { turn_id: 'second-turn' })
    + message('second turn message')
    + event('task_complete', { turn_id: 'second-turn' }),
  );
  context.after(log.cleanup);
  const index = await log.store.indexed(parent);
  const rows = index.page().events;
  assert.equal(rows.find(row => row.preview === 'first turn message')?.turnOrdinal, 1);
  assert.equal(rows.find(row => row.preview === 'second turn message')?.turnOrdinal, 2);
});

test('normal ingestion parses only appended bytes and buffers a partial multi-chunk UTF-8 line', async context => {
  const first = message('a'.repeat(300));
  const log = await fixture(first);
  context.after(log.cleanup);
  const index = await log.store.indexed(parent);
  const last = Buffer.from(message('摄'.repeat(50_000)));
  const partial = last.subarray(0, 65_537);
  const remainder = last.subarray(partial.length);
  await appendFile(log.path, partial);
  const before = index.revision;
  assert.equal((await log.store.indexed(parent)).revision, before);
  assert.equal(index.readByteCount, Buffer.byteLength(first) + partial.length);
  assert.equal(index.verificationByteCount, 256);
  await appendFile(log.path, remainder);
  assert.equal(await log.store.indexed(parent), index);
  const updated = index.delta(index.generation, before, 0, undefined);
  assert.equal(updated.events.length, 1);
  assert.ok(updated.events[0].preview.startsWith('摄'));
  assert.equal((await readDetail(log.path, updated.events[0].source, 'content', 0)).text, '摄'.repeat(32768));
  assert.equal(index.readByteCount, Buffer.byteLength(first) + last.length);
  assert.equal(index.verificationByteCount, 512);
  assert.equal((await log.store.indexed(parent)).readByteCount, index.readByteCount);
  assert.equal(index.verificationByteCount, 512);
});

test('rebuilds on truncation, inode replacement, same-length edit and larger in-place replacement', async context => {
  const log = await fixture(message('old content'.repeat(50)));
  context.after(log.cleanup);
  const original = await log.store.indexed(parent);
  await writeFile(log.path, message('large rewrite'.repeat(80)));
  const bigger = await log.store.indexed(parent);
  assert.notEqual(bigger.generation, original.generation);
  assert.equal(bigger.delta(original.generation, original.revision, 0, undefined).reset, true);
  await writeFile(log.path, message('xx'));
  const shorter = await log.store.indexed(parent);
  assert.notEqual(shorter.generation, bigger.generation);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(log.path, message('yy'));
  const edited = await log.store.indexed(parent);
  assert.notEqual(edited.generation, shorter.generation);
  await writeFile(log.path + '.replacement', message('zz'));
  await rename(log.path + '.replacement', log.path);
  const replaced = await log.store.indexed(parent);
  assert.notEqual(replaced.generation, edited.generation);
  assert.equal(replaced.page().events[0].preview, 'zz');
});

test('updates calls older than a page and combines background output only through explicit execution identifiers', async context => {
  const log = await fixture(call('start', 'exec_command', '{"cmd":"example"}')
    + output('start', { session_id: 8 })
    + Array.from({ length: 105 }, (_, i) => message(String(i))).join(''));
  context.after(log.cleanup);
  const index = await log.store.indexed(parent);
  const prior = index.revision;
  await appendFile(log.path, call('poll', 'write_stdin', '{"session_id":8,"chars":""}') + output('poll', { exit_code: 5, text: 'final-failed' }));
  await log.store.indexed(parent);
  const newer = index.page();
  const oldestPage = index.page(newer.events[0].source.offset);
  const oldest = index.page(oldestPage.events[0].source.offset);
  const start = oldest.events.find(record => record.callId === 'start')!;
  assert.equal(start.result?.status, 'running');
  assert.equal(start.processUpdates?.at(-1)?.exitCode, 5);
  const delta = index.delta(index.generation, prior, start.source.offset, newer.events.at(-1)?.source.offset);
  assert.ok(delta.events.some(record => record.source.offset === start.source.offset));
  assert.equal((await index.search('final-failed', 'exec_command', true, undefined)).events[0].callId, 'start');
});

test('reads V2 dispatch child IDs in the parent, isolates caches and exposes otherwise unpaired command items', async context => {
  const log = await fixture(call('spawn', 'spawn_agent', '{}') + output('spawn', { task_name: 'sample' })
    + event('item_completed', { item: { type: 'SubAgentActivity', id: 'spawn', kind: 'started', agent_thread_id: child, agent_path: '/root/example' } })
    + event('item_completed', { item: { type: 'CommandExecution', id: 'other', command: 'example', status: 'completed',
      aggregated_output: 'a'.repeat(300) + 'command-output-needle', exit_code: 0, duration: { secs: 1, nanos: 2000000 } } }));
  context.after(log.cleanup);
  // No child file has been created yet.
  const before = await log.store.indexed(parent);
  assert.equal(before.page().events.find(record => record.callId === 'spawn' && record.kind === 'tool')?.agents?.[0].id, child);
  const command = before.page().events.find(record => record.callId === 'other')!;
  assert.equal(command.durationMs, 1002);
  assert.equal((await readDetail(log.path, command.source, 'result', 0)).text.endsWith('command-output-needle'), true);
  assert.equal((await before.search('command-output-needle', '', false, undefined)).events[0].callId, 'other');
  const revision = before.revision;
  const bytes = before.readByteCount;
  await writeFile(log.pathFor(child), message('child only'));
  const childIndex = await log.store.indexed(child);
  assert.equal(childIndex.page().events[0].preview, 'child only');
  await appendFile(log.pathFor(child), message('additional child event'));
  const parentAgain = await log.store.indexed(parent);
  assert.equal(parentAgain, before);
  assert.equal(parentAgain.revision, revision);
  assert.equal(parentAgain.readByteCount, bytes);
  assert.deepEqual((await listSessions(log.home, child)).map(item => item.id), [child]);
});

test('links pending process exit event and retains own usage and timed turns outside inherited prefix', async context => {
  const log = await fixture(row('session_meta', { id: parent, forked_from_id: child, subagent_history_start_ordinal: 4 }, 0)
    + event('task_started', { turn_id: 'old' }, 1) + event('task_complete', { turn_id: 'old', duration_ms: 9000 }, 2)
    + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'copied' }] }, 3)
    + event('task_started', { turn_id: 'new' }, 4) + call('exec', 'exec_command', '{}') + output('exec', { session_id: 8 })
    + event('exec_command_end', { call_id: 'exec', exit_code: 0, aggregated_output: 'terminal text' })
    + row('compacted', { message: 'compaction boundary' })
    + row('token_usage_record', { thread_id: child, response_id: 'foreign', usage: { total_tokens: 900 } }, 5)
    + row('token_usage_record', { thread_id: parent, response_id: 'a', usage: { total_tokens: 7, input_tokens: 4, output_tokens: 3 } }, 6)
    + row('token_usage_record', { thread_id: parent, response_id: 'a', usage: { total_tokens: 7 } }, 7)
    + event('token_count', { info: { total_token_usage: { total_tokens: 99999 } } })
    + event('task_complete', { turn_id: 'new', duration_ms: 25 }, 8));
  context.after(log.cleanup);
  const index = await log.store.indexed(parent);
  const rows = index.page().events;
  assert.equal(rows.find(record => record.kind === 'inheritance')?.label, '继承历史');
  assert.equal(rows.find(record => record.preview === 'copied')?.inherited, true);
  assert.equal(rows.find(record => record.callId === 'exec')?.processUpdates?.[0].exitCode, 0);
  assert.ok(rows.some(record => record.kind === 'compaction'));
  const stats = index.statistics();
  assert.equal(stats.source, 'response-usage');
  assert.equal(stats.totalTokens, 7);
  assert.equal(stats.cachedInputTokens, null);
  assert.equal(stats.completedTurns, 1);
  assert.equal(stats.durationMs, 25);
});

test('distinguishes a copied fork cutoff from a referenced history base', async context => {
  const meta = (base?: { thread_id: string; end_ordinal_exclusive: number }) =>
    row('session_meta', { id: parent, forked_from_id: child, forked_from_ordinal_exclusive: 4, history_base: base }, base ? 2 : 0);
  const copied = await fixture(meta() + event('task_started', { turn_id: 'copied' }, 1)
    + row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'copied prefix' }] }, 2)
    + event('task_complete', { turn_id: 'copied', duration_ms: 4000 }, 3)
    + event('task_started', { turn_id: 'local' }, 4) + event('task_complete', { turn_id: 'local', duration_ms: 8 }, 5));
  const referenced = await fixture(meta({ thread_id: child, end_ordinal_exclusive: 2 })
    + event('task_started', { turn_id: 'different local' }, 3) + event('task_complete', { turn_id: 'different local', duration_ms: 11 }, 4));
  context.after(copied.cleanup);
  context.after(referenced.cleanup);
  const copiedIndex = await copied.store.indexed(parent);
  assert.equal(copiedIndex.page().events.find(record => record.preview === 'copied prefix')?.inherited, true);
  assert.equal(copiedIndex.statistics().durationMs, 8);
  assert.equal(copiedIndex.statistics().completedTurns, 1);
  const referencedIndex = await referenced.store.indexed(parent);
  assert.match(referencedIndex.page().events[0].preview, /历史引用/);
  assert.equal(referencedIndex.statistics().durationMs, 11);
  assert.equal(referencedIndex.statistics().completedTurns, 1);
});

test('lists historical agents once by UUID and refreshes relationships without opening another log', async context => {
  const missing = '00000000-0000-0000-0000-000000000023';
  const second = '00000000-0000-0000-0000-000000000024';
  const log = await fixture(call('spawn', 'spawn_agent', '{}') + output('spawn', { task_name: 'pending' })
    + event('item_completed', { item: { type: 'SubAgentActivity', id: 'spawn', kind: 'started', agent_thread_id: child, agent_path: '/root/example' } })
    + event('item_completed', { item: { type: 'CollabAgentToolCall', id: 'wait', tool: 'wait', receiver_thread_ids: [child] } })
    + event('collab_agent_spawn_end', { call_id: 'unknown', new_agent_nickname: '未登记代理' })
    + event('item_completed', { thread_id: missing, item: { type: 'SubAgentActivity', id: 'foreign', agent_thread_id: missing } })
    + Array.from({ length: 70 }, (_, index) => message(String(index))).join(''));
  context.after(log.cleanup);
  const index = await log.store.indexed(parent);
  assert.ok(index.page().events.every(record => !record.agents));
  const before = index.revision;
  assert.deepEqual(index.agentLinks(), [{ id: child, label: '/root/example', path: '/root/example' }, { id: null, label: '未登记代理' }]);
  await assert.rejects(log.store.indexed(child), { status: 404 });

  await appendFile(log.path, event('item_completed', { item: {
    type: 'SubAgentActivity', id: 'unknown', agent_thread_id: second, agent_path: '/root/resolved',
  } }));
  assert.equal(await log.store.indexed(parent), index);
  assert.ok(index.revision > before);
  const after = index.readByteCount;
  assert.deepEqual(index.agentLinks(), [{ id: child, label: '/root/example', path: '/root/example' }, { id: second, label: '/root/resolved', path: '/root/resolved' }]);
  assert.equal(index.readByteCount, after);
});
