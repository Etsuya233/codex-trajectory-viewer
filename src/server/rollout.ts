import type { BigIntStats } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Source } from '../model.ts';
import { finiteNatural, matchesHistoryEnd, object, readHead, RequestError, SESSION_ID, string } from './session.ts';
import type { LogSpan, RecordValue } from './session.ts';

const UUID = SESSION_ID.source.slice(1, -1);
export const ROLLOUT_NAME = new RegExp(
  `^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${UUID})(?:_(${UUID}))?\\.jsonl$`, 'i');

interface SessionLocation {
  path: string;
  archived: boolean;
}

interface RolloutSpan extends LogSpan {
  fingerprint: BigIntStats;
  owner: string | undefined;
}

export interface RolloutLog {
  spans: readonly RolloutSpan[];
  retryAt: number;
}

export interface RolloutSnapshot {
  log: RolloutLog;
  head: BigIntStats;
}

function roots(home: string) {
  return [{ path: join(home, 'sessions'), archived: false }, { path: join(home, 'archived_sessions'), archived: true }];
}

function storedPath(home: string, id: string) {
  try {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
    try {
      return string(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(id)?.rollout_path);
    } finally {
      db.close();
    }
  } catch {
    // Older installations or exported logs can be used without a compatible state database.
    return undefined;
  }
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export function recordThread(record: RecordValue | null) {
  return record?.type === 'session_meta' ? string(object(record.payload).id)?.toLowerCase() : undefined;
}

async function belongsTo(path: string, id: string, known?: RolloutSpan) {
  if (known?.path === path && known.owner === id) {
    const current = await fileStat(path);
    if (current && sameFile(known.fingerprint, current)
      && (current.size > known.fingerprint.size || current.mtimeNs === known.fingerprint.mtimeNs)) return true;
  }
  return recordThread(await readHead(path).catch(() => null)) === id;
}

async function pointedSession(home: string, id: string, known?: RolloutSpan) {
  const stored = storedPath(home, id);
  if (!stored || !isAbsolute(stored) || ROLLOUT_NAME.exec(basename(stored))?.[2].toLowerCase() !== id) return;
  const path = await realpath(stored).catch(() => null);
  if (!path) return;
  for (const root of roots(home)) {
    const dir = await realpath(root.path).catch(() => null);
    if (!dir || !inside(dir, path)) continue;
    if (await belongsTo(path, id, known)) return { path, archived: root.archived };
  }
}

async function* candidates(home: string, id: string): AsyncGenerator<SessionLocation> {
  async function* walk(directory: string, archived: boolean): AsyncGenerator<SessionLocation> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) yield* walk(path, archived);
      if (!entry.isFile()) continue;
      const name = ROLLOUT_NAME.exec(entry.name);
      if (name?.[2].toLowerCase() === id) yield { path, archived };
    }
  }
  for (const root of roots(home)) yield* walk(root.path, root.archived);
}

export async function locateSession(home: string, id: string, known?: RolloutSpan): Promise<SessionLocation> {
  if (!SESSION_ID.test(id)) throw new RequestError(400, '会话 ID 必须是 UUID。');
  home = resolve(home);
  id = id.toLowerCase();
  const pointed = await pointedSession(home, id, known);
  if (pointed) return pointed;
  for await (const candidate of candidates(home, id)) {
    const name = ROLLOUT_NAME.exec(basename(candidate.path));
    if (!name?.[3] || await belongsTo(candidate.path, id, known)) return candidate;
  }
  throw new RequestError(404, '找不到指定会话。');
}

export async function findSession(home: string, id: string): Promise<string> {
  return (await locateSession(home, id)).path;
}

function fileStat(path: string) {
  return stat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

function sameFile(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

interface HistoryBase {
  id: string;
  ordinal: number;
  end: number;
}

function historyBase(record: RecordValue | null) {
  const base = object(object(record?.payload).history_base);
  const id = string(base.thread_id)?.toLowerCase();
  const ordinal = finiteNatural(base.end_ordinal_exclusive);
  const end = finiteNatural(base.end_byte_offset);
  return id && SESSION_ID.test(id) && ordinal !== null && end !== null ? { id, ordinal, end } : null;
}

async function preceding(home: string, base: HistoryBase, visited: ReadonlySet<string>, before?: string) {
  for await (const candidate of candidates(home, base.id)) {
    const { path } = candidate;
    if (visited.has(path) || (before && basename(path) >= basename(before))) continue;
    const fingerprint = await fileStat(path);
    if (!fingerprint || BigInt(base.end) > fingerprint.size) continue;
    const record = await readHead(path).catch(() => null);
    const start = finiteNatural(record?.ordinal);
    if (recordThread(record) !== base.id || start === null) continue;
    const matches = base.end === 0 ? start === base.ordinal :
      start < base.ordinal && await matchesHistoryEnd(path, base.end, base.ordinal).catch(() => false);
    if (matches) return { path, record, fingerprint };
  }
}

export async function snapshotRollout(home: string, id: string, previous?: RolloutLog): Promise<RolloutSnapshot> {
  home = resolve(home);
  id = id.toLowerCase();
  const oldHead = previous?.spans.at(-1);
  const current = await locateSession(home, id, oldHead);
  const head = await fileStat(current.path);
  if (!head) throw new RequestError(409, '日志正在移动，请重试。');
  if (previous && oldHead?.path === current.path && sameFile(oldHead.fingerprint, head)
    && head.size >= oldHead.fingerprint.size && Date.now() < previous.retryAt) {
    const unchanged = await Promise.all(previous.spans.slice(0, -1).map(async span => {
      const latest = await fileStat(span.path);
      return latest !== null && sameFile(span.fingerprint, latest)
        && latest.size === span.fingerprint.size && latest.mtimeNs === span.fingerprint.mtimeNs;
    }));
    if (unchanged.every(Boolean)) return { log: previous, head };
  }

  const record = await readHead(current.path);
  const spans: RolloutSpan[] = [{
    path: current.path, start: 0, limit: null, inherited: false, fingerprint: head, owner: recordThread(record),
  }];
  const visited = new Set([current.path]);
  let currentId = id;
  let currentPath = current.path;
  let base = historyBase(record);
  while (base) {
    const prefix = await preceding(home, base, visited, base.id === currentId ? currentPath : undefined);
    if (!prefix) break;
    spans.push({
      path: prefix.path, start: 0, limit: base.end, inherited: base.id !== id,
      fingerprint: prefix.fingerprint, owner: base.id,
    });
    visited.add(prefix.path);
    currentId = base.id;
    currentPath = prefix.path;
    base = historyBase(prefix.record);
  }

  let start = 0;
  for (const span of spans.reverse()) {
    span.start = start;
    start += span.limit ?? 0;
  }
  // A missing archived prefix may become available later. Keep the readable tail in the meantime.
  return { log: { spans, retryAt: base ? Date.now() + 5_000 : Infinity }, head };
}

export function sameLayout(left: RolloutLog, right: RolloutLog) {
  return left === right || (left.spans.length === right.spans.length && left.spans.every((span, index) => {
    const other = right.spans[index];
    return span.path === other.path && span.limit === other.limit && span.inherited === other.inherited
      && (span.limit === null || (sameFile(span.fingerprint, other.fingerprint)
        && span.fingerprint.size === other.fingerprint.size && span.fingerprint.mtimeNs === other.fingerprint.mtimeNs));
  }));
}

export function locateRecord(log: RolloutLog, source: Source) {
  const span = log.spans.findLast(span => span.start <= source.offset);
  const offset = span ? source.offset - span.start : -1;
  if (!span || (span.limit !== null && offset + source.length >= span.limit)) {
    throw new RequestError(409, '日志已变化，请重新打开会话。');
  }
  return { path: span.path, source: { ...source, offset } };
}
