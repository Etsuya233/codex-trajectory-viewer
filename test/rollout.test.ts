import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { DetailPage, IndexedPage, SearchPage, SessionChoice, SessionMeta, SessionStats, TrajectoryDelta, TrajectoryEvent } from '../src/model.ts';
import { createTrajectoryApi } from '../src/server/api.ts';
import { RequestError } from '../src/server/session.ts';

const thread = '00000000-0000-0000-0000-000000000061';
const inherited = '00000000-0000-0000-0000-000000000062';
const segment = '00000000-0000-0000-0000-000000000063';
const superseded = '00000000-0000-0000-0000-000000000064';
const time = '2026-11-27T10:00:00.000Z';

function row(ordinal: number, type: string, payload: Record<string, unknown>) {
  return JSON.stringify({ timestamp: time, ordinal, type, payload }) + '\n';
}

function head(ordinal: number, id: string, base?: { id: string; bytes: number }) {
  const history_base = base && { thread_id: base.id, end_ordinal_exclusive: ordinal, end_byte_offset: base.bytes };
  return row(ordinal, 'session_meta', { id, history_base });
}

function message(ordinal: number, text: string) {
  return row(ordinal, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
}

function completed(ordinal: number, id: string) {
  return row(ordinal, 'event_msg', { type: 'task_complete', turn_id: id, duration_ms: 10 });
}

function detailUrl(event: TrajectoryEvent) {
  return '/detail?' + new URLSearchParams({
    offset: String(event.source.offset), length: String(event.source.length),
    digest: event.source.digest, field: 'content', from: '0',
  });
}

test('follows the current rollout and its clipped lineage for preview, history, search, detail and live updates', async context => {
  const home = await mkdtemp(join(tmpdir(), 'codex-viewer-rollouts-'));
  const live = join(home, 'sessions', '2026', '11', '27');
  await mkdir(live, { recursive: true });
  context.after(() => rm(home, { recursive: true, force: true }));
  const base = join(live, 'rollout-2026-11-27T10-00-00-' + inherited + '.jsonl');
  const old = join(live, 'rollout-2026-11-27T11-00-00-' + thread + '.jsonl');
  const next = join(live, 'rollout-2026-11-27T12-00-00-' + thread + '_' + segment + '.jsonl');
  const later = join(live, 'rollout-2026-11-27T13-00-00-' + thread + '_' + superseded + '.jsonl');
  const origin = head(0, inherited) + message(1, 'inherited message') + completed(2, 'parent-turn');
  const longText = '旧'.repeat(240) + ' needle beyond the preview';
  const middle = head(3, thread, { id: inherited, bytes: Buffer.byteLength(origin) }) + message(4, longText)
    + Array.from({ length: 64 }, (_, i) => message(i + 5, 'old message ' + i)).join('') + completed(69, 'old-turn');
  await writeFile(base, origin + message(3, 'parent abandoned tail'));
  await writeFile(old, middle + message(70, 'aborted squash attempt') + row(71, 'event_msg', { type: 'turn_aborted' }));
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(thread, old);

    const api = createTrajectoryApi(home);
    const path = '/api/sessions/' + thread;
    const request = <T>(suffix = '') => api(new URL('http://localhost' + path + suffix)) as Promise<T>;
    await request('/stats');
    const before = await request<IndexedPage>();
    assert.ok(before.events.some(event => event.label === 'turn_aborted'));
    const active = head(70, thread, { id: thread, bytes: Buffer.byteLength(middle) }) + message(71, 'write Handoff docs');
    await writeFile(next, active + completed(72, 'handoff'));
    await writeFile(later, head(70, thread, { id: thread, bytes: Buffer.byteLength(middle) }) + message(71, 'inactive newer filename'));
    db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(next, thread);

    const cold = await createTrajectoryApi(home)(new URL('http://localhost' + path)) as IndexedPage;
    assert.equal(cold.indexing, true);
    assert.equal(cold.events.at(-1)?.preview, 'write Handoff docs');
    assert.equal(cold.events.length, 50);
    assert.ok(cold.events.some(event => event.preview === 'old message 63'));
    assert.ok(!cold.events.some(event => event.label === 'turn_aborted'));

    const update = await request<TrajectoryDelta>('/updates?generation=' + before.generation + '&revision=' + before.revision);
    assert.equal(update.reset, true);
    let page = await request<IndexedPage>();
    const all = [...page.events];
    while (page.earlier) {
      page = await request<IndexedPage>('?before=' + page.events[0].source.offset + '&generation=' + page.generation);
      all.unshift(...page.events);
    }
    assert.equal(new Set(all.map(event => event.source.offset)).size, all.length);
    assert.equal(all.find(event => event.preview === 'inherited message')?.inherited, true);
    assert.equal(all.filter(event => event.preview.startsWith('old message ')).length, 64);
    assert.equal(all.at(-1)?.preview, 'write Handoff docs');
    for (const text of ['parent abandoned tail', 'aborted squash attempt', 'inactive newer filename']) {
      assert.ok(!all.some(event => event.preview === text), text);
    }
    const search = await request<SearchPage>('/search?q=needle');
    assert.equal(search.events.length, 1);
    assert.equal((await request<DetailPage>(detailUrl(search.events[0]))).text, longText);
    assert.equal((await request<DetailPage>(detailUrl(all.at(-1)!))).text, 'write Handoff docs');
    await assert.rejects(request(detailUrl(before.events.find(event => event.preview === 'aborted squash attempt')!)),
      (error: RequestError) => error.status === 409);
    assert.equal((await request<SessionStats>('/stats')).completedTurns, 2);
    assert.equal((await request<SessionMeta>('/meta')).date, '2026-11-27T12-00-00');

    const indexed = await request<IndexedPage>();
    await appendFile(next, message(73, 'live append'));
    const append = await request<TrajectoryDelta>('/updates?generation=' + indexed.generation + '&revision=' + indexed.revision);
    assert.equal(append.reset, false);
    assert.deepEqual(append.events.map(event => event.preview), ['live append']);
  } finally {
    db.close();
  }
});

test('locates suffix-only archives with missing or stale state and lists the thread once', async context => {
  const home = await mkdtemp(join(tmpdir(), 'codex-viewer-archived-rollouts-'));
  const archive = join(home, 'archived_sessions');
  await mkdir(archive);
  context.after(() => rm(home, { recursive: true, force: true }));
  const old = join(archive, 'rollout-2026-11-27T10-00-00-' + thread + '_' + superseded + '.jsonl');
  const next = join(archive, 'rollout-2026-11-27T11-00-00-' + thread + '_' + segment + '.jsonl');
  const prefix = row(0, 'session_meta', { id: thread, base_instructions: 'x'.repeat(70_000) })
    + message(1, 'archive prefix');
  await writeFile(old, prefix);
  const api = createTrajectoryApi(home);
  const path = 'http://localhost/api/sessions';
  const session = path + '/' + thread;
  await api(new URL(session + '/stats'));
  const before = await api(new URL(session)) as IndexedPage;
  assert.equal(before.events.at(-1)?.preview, 'archive prefix');

  await writeFile(next, head(2, thread, { id: thread, bytes: Buffer.byteLength(prefix) }) + message(3, 'archive latest'));
  const decoy = join(archive, 'rollout-2026-11-27T12-00-00-' + thread + '_' + inherited + '.jsonl');
  await writeFile(decoy, head(0, inherited) + message(1, 'wrong thread'));
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(thread, decoy);

    const update = await api(new URL(session + '/updates?generation=' + before.generation + '&revision=' + before.revision)) as TrajectoryDelta;
    assert.equal(update.reset, true);
    const page = await api(new URL(session)) as IndexedPage;
    assert.equal(page.events.at(-1)?.preview, 'archive latest');
    assert.ok(page.events.some(event => event.preview === 'archive prefix'));
    const choices = await api(new URL(path + '?q=' + thread)) as SessionChoice[];
    assert.deepEqual(choices.map(choice => [choice.id, choice.archived]), [[thread, true]]);
    assert.equal((await api(new URL(session + '/meta')) as SessionMeta).archived, true);
  } finally {
    db.close();
  }
});
