import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionCatalog, listSessions } from '../src/server/catalog.ts';

const parent = '00000000-0000-0000-0000-0000000000b1';
const second = '00000000-0000-0000-0000-0000000000b2';
const child = '00000000-0000-0000-0000-0000000000b3';
const missing = '00000000-0000-0000-0000-0000000000b4';
const time = '2026-11-27T10:00:00.000Z';

function record(type: string, payload: Record<string, unknown>) {
  return JSON.stringify({ timestamp: time, ordinal: 0, type, payload }) + '\n';
}

function mainMessage(text: string) {
  return record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
}

function subagentHead(id: string, nickname: string, path: string, parentId: string) {
  return record('session_meta', {
    id,
    parent_thread_id: parentId,
    thread_source: 'subagent',
    agent_nickname: nickname,
    agent_path: path,
    agent_role: 'worker',
    source: { subagent: { thread_spawn: {
      parent_thread_id: parentId, agent_nickname: nickname, agent_path: path, agent_role: 'worker',
    } } },
  });
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'codex-viewer-catalog-'));
  const live = join(home, 'sessions', '2026', '11', '27');
  await mkdir(live, { recursive: true });
  const pathFor = (id: string) => join(live, `rollout-2026-11-27T10-00-00-${id}.jsonl`);
  const write = async (id: string, contents: string) => {
    await writeFile(pathFor(id), contents);
    return pathFor(id);
  };
  const index = async (entries: Array<{ id: string; name: string; updated_at: string }>) => {
    await writeFile(join(home, 'session_index.jsonl'),
      entries.map(entry => JSON.stringify({ id: entry.id, thread_name: entry.name, updated_at: entry.updated_at })).join('\n') + '\n');
  };
  return { home, live, pathFor, write, index, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test('lists named sessions from the Codex index, filters by name or ID and sorts by update time', async context => {
  const log = await fixture();
  context.after(log.cleanup);
  await log.write(parent, mainMessage('parent'));
  await log.write(second, mainMessage('second'));
  await log.index([
    { id: parent, name: '评估轨迹查看器', updated_at: '2026-11-27T11:00:00Z' },
    { id: second, name: '设计会话下拉菜单', updated_at: '2026-11-27T12:00:00Z' },
  ]);

  assert.deepEqual((await listSessions(log.home, '')).map(item => [item.id, item.name]), [
    [second, '设计会话下拉菜单'],
    [parent, '评估轨迹查看器'],
  ]);
  assert.deepEqual((await listSessions(log.home, '下拉')).map(item => item.id), [second]);
  assert.deepEqual((await listSessions(log.home, '00b1')).map(item => item.id), [parent]);
  assert.deepEqual((await listSessions(log.home, '不存在')).map(item => item.id), []);
});

test('omits subagent rollouts from the thread list but keeps older unindexed main threads', async context => {
  const log = await fixture();
  context.after(log.cleanup);
  await log.write(parent, mainMessage('parent'));
  await log.write(child, subagentHead(child, 'Raman', '/root/m1_sol', parent));
  const old = '00000000-0000-0000-0000-0000000000b5';
  await log.write(old, mainMessage('older main thread'));
  await log.index([{ id: parent, name: '父会话', updated_at: '2026-11-27T11:00:00Z' }]);

  const sessions = await listSessions(log.home, '');
  assert.deepEqual(sessions.map(item => [item.id, item.name]), [
    [parent, '父会话'],
    [old, null],
  ]);
});

test('resolves main and subagent metadata from the index and the child head', async context => {
  const log = await fixture();
  context.after(log.cleanup);
  await log.write(parent, mainMessage('parent'));
  await log.write(child, subagentHead(child, 'Raman', '/root/m1_sol', parent));
  await log.index([{ id: parent, name: '评估轨迹查看器', updated_at: '2026-11-27T11:00:00Z' }]);
  const catalog = new SessionCatalog(log.home);

  assert.deepEqual(await catalog.meta(parent), {
    id: parent, name: '评估轨迹查看器', kind: 'thread', parentId: null,
    agentPath: null, agentRole: null, date: '2026-11-27T10-00-00', archived: false,
  });
  assert.deepEqual(await catalog.meta(child), {
    id: child, name: 'Raman', kind: 'subagent', parentId: parent,
    agentPath: '/root/m1_sol', agentRole: 'worker', date: '2026-11-27T10-00-00', archived: false,
  });
  await log.index([
    { id: parent, name: '评估轨迹查看器', updated_at: '2026-11-27T11:00:00Z' },
    { id: child, name: '子代理会话', updated_at: '2026-11-27T11:00:00Z' },
  ]);
  assert.deepEqual(await catalog.meta(child), {
    id: child, name: 'Raman', kind: 'subagent', parentId: parent,
    agentPath: '/root/m1_sol', agentRole: 'worker', date: '2026-11-27T10-00-00', archived: false,
  });
});

test('fills subagent nicknames from child heads and leaves unresolved links untouched', async context => {
  const log = await fixture();
  context.after(log.cleanup);
  await log.write(parent, mainMessage('parent'));
  await log.write(child, subagentHead(child, 'Raman', '/root/m1_sol', parent));
  await log.index([{ id: parent, name: '父会话', updated_at: '2026-11-27T11:00:00Z' }]);
  const catalog = new SessionCatalog(log.home);

  assert.deepEqual(await catalog.resolveAgents([
    { id: child, label: '/root/m1_sol', path: '/root/m1_sol' },
    { id: null, label: '未登记代理' },
    { id: missing, label: missing },
  ]), [
    { id: child, label: '/root/m1_sol', path: '/root/m1_sol', name: 'Raman', role: 'worker' },
    { id: null, label: '未登记代理' },
    { id: missing, label: missing },
  ]);
});

test('reports archived sessions separately', async context => {
  const log = await fixture();
  context.after(async () => {
    await rm(join(log.home, 'archived_sessions'), { recursive: true, force: true });
    await log.cleanup();
  });
  const archived = join(log.home, 'archived_sessions');
  await mkdir(archived, { recursive: true });
  await writeFile(join(archived, `rollout-2026-11-20T10-35-13-${child}.jsonl`), mainMessage('archived'));
  await log.index([{ id: child, name: '归档会话', updated_at: '2026-11-20T10:35:13Z' }]);

  const [choice] = await listSessions(log.home, '');
  assert.equal(choice.id, child);
  assert.equal(choice.archived, true);
  assert.equal((await new SessionCatalog(log.home).meta(child)).archived, true);
});
