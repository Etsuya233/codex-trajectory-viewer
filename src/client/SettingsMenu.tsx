import { defaultSettings, viewerSettings, type SettingChange, type ViewerSettings } from '../settings.ts';

const STORAGE_KEY = 'codex-trajectory:settings:v1';

export function readBrowserSettings(): ViewerSettings {
  try {
    return viewerSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return defaultSettings;
  }
}

export function writeBrowserSettings(settings: ViewerSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The current view can still use the settings without browser storage.
  }
}

export interface SettingsMenuProps {
  settings: ViewerSettings;
  changeSetting: (change: SettingChange) => void;
  saving: boolean;
  settingsError: string | null;
}

export function SettingsMenu({ settings, changeSetting, saving, settingsError }: SettingsMenuProps) {
  return <div className="settings-menu" aria-busy={saving}>
    <fieldset>
      <legend>折叠设置</legend>
      <button type="button" role="switch" className="menu-option" data-dropdown-option autoFocus
        aria-label="工具折叠" aria-checked={settings.foldTools} aria-disabled={saving || undefined}
        onClick={() => changeSetting({ key: 'foldTools', value: !settings.foldTools })}>
        <span className="menu-option-main">{settings.foldTools ? '折叠已开启' : '折叠已关闭'}</span>
        <span className="settings-switch" aria-hidden="true" />
      </button>
      <button type="button" role="switch" className="menu-option" data-dropdown-option
        aria-checked={settings.keepLatestOpen} disabled={!settings.foldTools} aria-disabled={saving || undefined}
        onClick={() => changeSetting({ key: 'keepLatestOpen', value: !settings.keepLatestOpen })}>
        <span className="menu-option-main">最新输出不折叠</span>
        <span className="settings-switch" aria-hidden="true" />
      </button>
    </fieldset>
    <fieldset>
      <legend>加载设置</legend>
      <button type="button" role="switch" className="menu-option" data-dropdown-option
        aria-label="主线程全量加载" aria-checked={settings.loadAll} aria-disabled={saving || undefined}
        onClick={() => changeSetting({ key: 'loadAll', value: !settings.loadAll })}>
        <span className="menu-option-main">{settings.loadAll ? '全量加载' : '部分加载'}</span>
        <span className="settings-switch" aria-hidden="true" />
      </button>
    </fieldset>
    {settingsError ? <p className="menu-state" role="alert">{settingsError}</p> : null}
  </div>;
}
