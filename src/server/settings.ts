import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSettings, isSettingKey, type ViewerSettings } from '../settings.ts';
import { RequestError } from './session.ts';

export async function accessSettings(codexHome: string, args: Record<string, unknown>): Promise<ViewerSettings | null> {
  const folder = join(codexHome, 'trajectory-viewer-settings');
  if (Object.keys(args).length === 0) {
    const settings = { ...defaultSettings };
    await Promise.all(Object.keys(settings).filter(isSettingKey).map(async key => {
      const value = await readFile(join(folder, key), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (value === 'true' || value === 'false') settings[key] = value === 'true';
    }));
    return settings;
  }
  const { key, value } = args;
  if (Object.keys(args).length !== 2 || !isSettingKey(key) || typeof value !== 'boolean') {
    throw new RequestError(400, '无效的查看器设置。');
  }
  await mkdir(folder, { recursive: true });
  // Each setting is replaced atomically so separate panel processes can update unrelated options.
  const temp = join(folder, randomUUID());
  try {
    await writeFile(temp, String(value), { flag: 'wx' });
    await rename(temp, join(folder, key));
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return null;
}
