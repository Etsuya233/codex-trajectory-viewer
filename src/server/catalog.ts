import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionChoice } from '../model.ts';
import { SESSION_ID } from './session.ts';

const LIMIT = 100;
const ROLLOUT_NAME = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/;

export async function listSessions(home: string, term: string): Promise<SessionChoice[]> {
  const results: SessionChoice[] = [];
  const seen = new Set<string>();
  const query = term.trim().toLowerCase();
  async function discover(path: string, archived: boolean) {
    const directories = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    directories.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of directories) {
      if (results.length >= LIMIT) break;
      if (entry.isDirectory()) await discover(join(path, entry.name), archived);
      if (!entry.isFile() || !entry.name.toLowerCase().includes(query)) continue;
      const match = ROLLOUT_NAME.exec(entry.name);
      if (!match || !SESSION_ID.test(match[2])) continue;
      const id = match[2].toLowerCase();
      if (!seen.has(id)) results.push({ id, date: match[1], archived });
      seen.add(id);
    }
  }
  await discover(join(home, 'sessions'), false);
  await discover(join(home, 'archived_sessions'), true);
  return results.sort((a, b) => b.date.localeCompare(a.date));
}
