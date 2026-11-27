import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentLink, SessionChoice, SessionMeta } from '../model.ts';
import { object, readHead, SESSION_ID, string } from './session.ts';
import { locateSession, recordThread, ROLLOUT_NAME } from './rollout.ts';
import type { RecordValue } from './session.ts';

const LIMIT = 100;

interface IndexedName {
  name: string;
  updatedAt: string | null;
}

interface CachedIndex {
  key: string;
  entries: Map<string, IndexedName>;
}

interface CachedMeta {
  key: string;
  meta: SessionMeta;
}

interface CachedKind {
  key: string;
  subagent: boolean;
}

async function fileKey(path: string): Promise<string> {
  const snapshot = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  return snapshot === null ? 'missing' : `${snapshot.mtimeMs}:${snapshot.size}`;
}

async function readIndex(home: string, key: string): Promise<CachedIndex> {
  const entries = new Map<string, IndexedName>();
  const text = await readFile(join(home, 'session_index.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = object(JSON.parse(line));
      const id = string(value.id)?.toLowerCase();
      const name = string(value.thread_name)?.trim();
      if (!id || !SESSION_ID.test(id) || !name) continue;
      entries.set(id, { name, updatedAt: string(value.updated_at) ?? null });
    } catch {
      // Codex appends the index; ignore a partial trailing line.
    }
  }
  return { key, entries };
}

function sessionMeta(
  id: string,
  location: { path: string; archived: boolean },
  indexed: IndexedName | undefined,
  head: RecordValue | null,
): SessionMeta {
  const payload = object(head?.payload);
  const spawn = object(object(object(payload.source).subagent).thread_spawn);
  const nickname = string(payload.agent_nickname) ?? string(spawn.agent_nickname);
  const agentPath = string(payload.agent_path) ?? string(spawn.agent_path) ?? null;
  const agentRole = string(payload.agent_role) ?? string(spawn.agent_role) ?? null;
  const parentId = string(payload.parent_thread_id) ?? string(spawn.parent_thread_id) ?? null;
  const subagent = payload.thread_source === 'subagent' || agentPath !== null || parentId !== null;
  const basename = location.path.split(/[\\/]/).at(-1) ?? '';
  return {
    id,
    name: indexed?.name ?? (subagent ? nickname ?? null : null),
    kind: subagent ? 'subagent' : 'thread',
    parentId,
    agentPath,
    agentRole,
    date: ROLLOUT_NAME.exec(basename)?.[1] ?? null,
    archived: location.archived,
  };
}

/** Reads the lightweight Codex session index and per-session head records with small caches. */
export class SessionCatalog {
  private readonly home: string;
  private index: CachedIndex | null = null;
  private readonly metas = new Map<string, CachedMeta>();
  private readonly kinds = new Map<string, CachedKind>();

  constructor(home: string) {
    this.home = home;
  }

  private async indexEntries(): Promise<Map<string, IndexedName>> {
    const key = await fileKey(join(this.home, 'session_index.jsonl'));
    if (this.index?.key !== key) this.index = await readIndex(this.home, key);
    return this.index.entries;
  }

  private async isSubagent(path: string): Promise<boolean> {
    const key = await fileKey(path);
    const cached = this.kinds.get(path);
    if (cached?.key === key) return cached.subagent;
    const payload = object((await readHead(path).catch(() => null))?.payload);
    const spawn = object(object(object(payload.source).subagent).thread_spawn);
    const subagent = payload.thread_source === 'subagent' || payload.agent_path !== undefined
      || payload.agent_nickname !== undefined || spawn.agent_path !== undefined;
    this.kinds.set(path, { key, subagent });
    return subagent;
  }

  async sessions(term: string): Promise<SessionChoice[]> {
    const names = await this.indexEntries();
    const indexed = names.size > 0;
    const results: SessionChoice[] = [];
    const seen = new Set<string>();
    const query = term.trim().toLowerCase();

    const discover = async (path: string, archived: boolean): Promise<void> => {
      const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        if (results.length >= LIMIT) return;
        if (entry.isDirectory()) {
          await discover(join(path, entry.name), archived);
          continue;
        }
        if (!entry.isFile()) continue;
        const match = ROLLOUT_NAME.exec(entry.name);
        if (!match) continue;
        const id = match[2].toLowerCase();
        if (seen.has(id)) continue;
        const entryPath = join(path, entry.name);
        if (match[3] && recordThread(await readHead(entryPath).catch(() => null)) !== id) continue;
        const indexedName = names.get(id);
        // Subagents are reachable from their parent, not from the thread list.
        if (indexed && indexedName === undefined && await this.isSubagent(entryPath)) continue;
        seen.add(id);
        if (query && !id.includes(query) && !indexedName?.name.toLowerCase().includes(query)) continue;
        results.push({
          id,
          name: indexedName?.name ?? null,
          date: match[1],
          updatedAt: indexedName?.updatedAt ?? null,
          archived,
        });
      }
    };

    await discover(join(this.home, 'sessions'), false);
    await discover(join(this.home, 'archived_sessions'), true);
    return results.sort((left, right) =>
      (right.updatedAt ?? right.date).localeCompare(left.updatedAt ?? left.date));
  }

  async meta(id: string): Promise<SessionMeta> {
    const key = id.toLowerCase();
    const location = await locateSession(this.home, key);
    const snapshot = await fileKey(location.path);
    const names = await this.indexEntries();
    const cacheKey = `${location.path}:${snapshot}:${this.index?.key ?? ''}`;
    const cached = this.metas.get(key);
    if (cached?.key === cacheKey) return cached.meta;

    const indexed = names.get(key);
    const head = indexed?.name ? null : await readHead(location.path).catch(() => null);
    const meta = sessionMeta(key, location, indexed, head);
    this.metas.set(key, { key: cacheKey, meta });
    return meta;
  }

  /** Fill missing subagent nicknames from each child rollout's own session_meta. */
  async resolveAgents(links: readonly AgentLink[]): Promise<AgentLink[]> {
    return Promise.all(links.map(async link => {
      if (!link.id || (link.name && link.path)) return link;
      const meta = await this.meta(link.id).catch(() => null);
      if (!meta || (!meta.name && !meta.agentPath)) return link;
      const name = link.name ?? meta.name;
      const path = link.path ?? meta.agentPath;
      const role = link.role ?? meta.agentRole;
      return {
        ...link,
        ...(name ? { name } : {}),
        ...(path ? { path } : {}),
        ...(role ? { role } : {}),
      };
    }));
  }
}

export async function listSessions(home: string, term: string): Promise<SessionChoice[]> {
  return new SessionCatalog(home).sessions(term);
}
