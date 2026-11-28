import { useEffect, useRef, useState } from 'react';
import type { SessionMeta } from '../model.ts';
import type { SettingChange, ViewerSettings } from '../settings.ts';
import { errorMessage, request, sessionUrl } from './api.ts';
import { Dropdown } from './Dropdown.tsx';
import { SessionMenu, sessionLabel } from './SessionTools.tsx';
import { readBrowserSettings, writeBrowserSettings, type SettingsMenuProps } from './SettingsMenu.tsx';
import { Trajectory } from './Trajectory.tsx';
import { applyTheme, initialTheme, rememberTheme, storedTheme, type Theme } from './theme.ts';
import { useTrajectory } from './useTrajectory.ts';

const LAST_SESSION_KEY = 'codex-trajectory:last-session';
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function readLastSession() {
  try {
    const value = localStorage.getItem(LAST_SESSION_KEY)?.trim();
    return value && SESSION_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writeLastSession(id: string) {
  try {
    localStorage.setItem(LAST_SESSION_KEY, id);
  } catch {
    // Remembering the last session is optional; a blocked storage area is harmless.
  }
}

function LoadedSession({ id, active, metas, preferences, openAgent, openMainAgent, onChoose }: {
  id: string;
  active: boolean;
  metas: ReadonlyMap<string, SessionMeta>;
  preferences: SettingsMenuProps;
  openAgent: (id: string) => void;
  openMainAgent: (id: string) => void;
  onChoose: () => void;
}) {
  const loadAll = preferences.settings.loadAll && metas.get(id)?.kind === 'thread';
  const { page, fault, working, fetchPage, viewEpoch, historyFault, loadingHistory, retryHistory } = useTrajectory(id, active, loadAll);
  if (page) return <Trajectory key={viewEpoch}
    {...{ id, page, active, working, fault, fetchPage, metas, preferences, loadAll, historyFault, loadingHistory, retryHistory, openAgent, openMainAgent }} />;
  if (fault) return <p className="empty" role="alert">{fault}
    <button type="button" onClick={() => void fetchPage('recent')}>重试</button>
    <button type="button" onClick={onChoose}>选择其他会话</button>
  </p>;
  return <p className="empty" role="status">正在定位会话并读取最近记录…</p>;
}

function currentStack() {
  const id = new URLSearchParams(location.search).get('session');
  if (!id) return [];
  const stack: unknown = history.state?.trajectoryStack;
  if (Array.isArray(stack) && stack.every(item => typeof item === 'string') && stack.at(-1) === id) return stack as string[];
  return [id];
}

function storeStack(stack: string[]) {
  const url = new URL(location.href);
  const id = stack.at(-1);
  if (id) url.searchParams.set('session', id);
  else url.searchParams.delete('session');
  history.pushState({ trajectoryStack: stack }, '', url);
}

function subagentLabel(meta: SessionMeta) {
  const name = meta.name?.trim();
  const path = meta.agentPath?.trim();
  if (name && path) return `${name} · ${path}`;
  return name || path || meta.id.slice(0, 8);
}

function Welcome({ open, openCurrentChat }: {
  open: (id: string, name?: string | null) => void;
  openCurrentChat?: () => void;
}) {
  return <section className="welcome">
    <div className="welcome-card">
      <div className="welcome-intro">
        <h2>查看一次 Codex 会话的轨迹</h2>
        <p>从本机只读日志读取轮次、工具调用和结果。选择下面的会话，或按 UUID 直接打开。</p>
      </div>
      <div className="welcome-picker">
        <SessionMenu current="" choose={open} chooseCurrentChat={openCurrentChat} />
      </div>
      <p className="welcome-hint">会话列表只读取索引元数据；打开后才读取轨迹。</p>
    </div>
  </section>;
}

interface AppProps {
  embedded?: boolean;
  hostSession?: string;
  hostTheme?: Theme;
  initialSettings?: ViewerSettings;
  saveSetting?: (change: SettingChange) => Promise<void>;
}

export function App({ embedded = false, hostSession, hostTheme, initialSettings, saveSetting }: AppProps) {
  const currentChatId = embedded && hostSession && SESSION_ID.test(hostSession) ? hostSession.toLowerCase() : undefined;
  const [stack, setStack] = useState(() => {
    if (embedded) return currentChatId ? [currentChatId] : [];
    const current = currentStack();
    if (current.length) return current;
    const last = readLastSession();
    return last ? [last] : [];
  });
  const id = stack.at(-1) ?? '';
  const [reload, setReload] = useState(0);
  const metaCache = useRef(new Map<string, SessionMeta>());
  const [metas, setMetas] = useState<ReadonlyMap<string, SessionMeta>>(new Map());
  const [selectedTitles, setSelectedTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [theme, setTheme] = useState<Theme>(() => hostTheme ?? initialTheme());
  const [settings, setSettings] = useState(() => initialSettings ?? readBrowserSettings());
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  async function changeSetting(change: SettingChange) {
    if (saving) return;
    setSettingsError(null);
    setSaving(true);
    try {
      const next = { ...settings, [change.key]: change.value };
      if (saveSetting) await saveSetting(change);
      else writeBrowserSettings(next);
      setSettings(next);
    } catch (error) {
      setSettingsError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const preferences = { settings, changeSetting, saving, settingsError };

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (hostTheme) setTheme(hostTheme);
  }, [hostTheme]);

  useEffect(() => {
    if (hostTheme) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (storedTheme()) return;
      setTheme(media.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [hostTheme]);

  useEffect(() => {
    if (embedded || !id) return;
    writeLastSession(id);
  }, [embedded, id]);

  useEffect(() => {
    const missing = stack.filter(session => !metaCache.current.has(session));
    if (missing.length === 0) {
      if (metaCache.current.size !== metas.size) setMetas(new Map(metaCache.current));
      return;
    }
    const abort = new AbortController();
    void Promise.all(missing.map(async session => {
      try {
        const meta = await request<SessionMeta>(sessionUrl(session) + '/meta', abort.signal);
        metaCache.current.set(session, meta);
      } catch {
        // A name is optional; the trajectory request reports the actionable fault.
      }
    })).then(() => {
      if (!abort.signal.aborted) setMetas(new Map(metaCache.current));
    });
    return () => abort.abort();
  }, [stack]);

  useEffect(() => {
    if (embedded) return;
    const navigate = () => {
      const next = currentStack();
      setStack(next);
    };
    window.addEventListener('popstate', navigate);
    return () => window.removeEventListener('popstate', navigate);
  }, [embedded]);

  function navigate(next: string[]) {
    if (!embedded) storeStack(next);
    setStack(next);
  }

  function open(next: string, name?: string | null) {
    const value = next.trim().toLowerCase();
    if (!value) return;
    const title = name?.trim();
    if (title) setSelectedTitles(titles => new Map(titles).set(value, title));
    if (stack.length === 1 && stack[0] === value) setReload(count => count + 1);
    else navigate([value]);
  }

  function showChat(session: string) {
    if (id.toLowerCase() === session.toLowerCase()) return;
    const existing = stack.findIndex(item => item.toLowerCase() === session.toLowerCase());
    navigate(existing >= 0 ? stack.slice(0, existing + 1) : [session]);
  }

  function openCurrentChat() {
    if (currentChatId) showChat(currentChatId);
  }

  function inspectAgent(agent: string) {
    const existing = stack.indexOf(agent);
    if (existing === stack.length - 1) return;
    navigate(existing >= 0 ? stack.slice(0, existing + 1) : [...stack, agent]);
  }

  function backToParent() {
    if (stack.length > 1) {
      if (embedded) navigate(stack.slice(0, -1));
      else history.back();
    }
  }

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    rememberTheme(next);
    setTheme(next);
  }

  function chooseAnother() {
    if (!embedded) {
      try {
        localStorage.removeItem(LAST_SESSION_KEY);
      } catch {
        // The welcome page is still reachable even when storage is unavailable.
      }
    }
    navigate([]);
  }

  const current = id ? metas.get(id) ?? null : null;
  const parentId = stack.length > 1 ? stack.at(-2)! : current?.kind === 'subagent' ? current.parentId : null;
  const parentName = parentId ? metas.get(parentId)?.name ?? null : null;
  const trigger = !id ? '选择会话'
    : current?.kind === 'subagent' ? subagentLabel(current)
      : sessionLabel(selectedTitles.get(id) ?? current?.name, id);
  const detail = id ? `${trigger} · ${id}` : '切换会话';

  return <main className="shell">
    <header className="session-bar">
      <div className="session-bar-main">
        <h1>Codex 轨迹</h1>
        <Dropdown className="session-trigger" ariaLabel={id ? `切换会话，正在查看${trigger}` : trigger} title={detail}
          minWidth={300} maxWidth={520} label={<span className="session-trigger-name">{trigger}</span>}>
          {close => <SessionMenu current={id}
            choose={(choice, name) => { close(); open(choice, name); }}
            chooseCurrentChat={currentChatId ? () => { close(); openCurrentChat(); } : undefined} />}
        </Dropdown>
        {id === currentChatId ? <span className="session-badge">当前聊天</span> : null}
        {current?.kind === 'subagent' ? <span className="session-badge session-badge-agent">子代理</span> : null}
      </div>
      <div className="session-bar-actions">
        {stack.length > 1
          ? <button type="button" onClick={backToParent} title={parentName ? `返回「${parentName}」` : undefined}>返回父会话</button>
          : current?.kind === 'subagent' && current.parentId
            ? <button type="button" onClick={() => navigate([current.parentId!])}>打开父会话</button>
            : null}
        <button type="button" className="theme-toggle" onClick={toggleTheme}
          aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
          title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}>
          <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
        </button>
      </div>
    </header>
    <div className="session-stack">
      {stack.map((session, index) => {
        const active = index === stack.length - 1;
        return <div className="session-layer" key={session + ':' + reload} data-active={active}
          aria-hidden={!active || undefined} inert={!active || undefined}>
          <LoadedSession id={session} active={active} metas={metas} preferences={preferences} openAgent={inspectAgent}
            openMainAgent={showChat} onChoose={chooseAnother} />
        </div>;
      })}
      {stack.length === 0 ? <Welcome open={open} openCurrentChat={currentChatId ? openCurrentChat : undefined} /> : null}
    </div>
  </main>;
}
