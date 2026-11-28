export const defaultSettings = {
  foldTools: true,
  keepLatestOpen: true,
  loadAll: true,
};

export type ViewerSettings = typeof defaultSettings;
export type SettingKey = keyof ViewerSettings;
export type SettingChange = { key: SettingKey; value: boolean };

export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === 'string' && Object.hasOwn(defaultSettings, key);
}

export function viewerSettings(value: unknown): ViewerSettings {
  const settings = { ...defaultSettings };
  if (!value || typeof value !== 'object') return settings;
  for (const [key, entry] of Object.entries(value)) {
    if (isSettingKey(key) && typeof entry === 'boolean') settings[key] = entry;
  }
  return settings;
}
