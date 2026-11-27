import { useEffect, useRef, useState } from 'react';
import type { SessionMeta } from '../model.ts';
import { request, sessionUrl } from './api.ts';
import { Dropdown } from './Dropdown.tsx';
import { SessionMenu, sessionLabel } from './SessionTools.tsx';
import { Trajectory } from './Trajectory.tsx';
import { useTrajectory } from './useTrajectory.ts';

function LoadedSession({ id, active, openAgent }: { id: string; active: boolean; openAgent: (id: string) => void }) {
  const { page, fault, working, fetchPage, viewEpoch } = useTrajectory(id, active);
  if (page) return <Trajectory key={viewEpoch} {...{ id, page, active, working, fault, fetchPage, openAgent }} />;
  if (fault) return <p className="empty" role="alert">{fault} <button type="button" onClick={() => void fetchPage('recent')}>重试</button></p>;
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

interface AppProps {
  embedded?: boolean;
  hostSession?: string;
}

export function App({ embedded = false, hostSession }: AppProps) {
  const [stack, setStack] = useState(() => embedded ? hostSession ? [hostSession] : [] : currentStack());
  const id = stack.at(-1) ?? '';
  const [reload, setReload] = useState(0);
  const metaCache = useRef(new Map<string, SessionMeta>());
  const [metas, setMetas] = useState<ReadonlyMap<string, SessionMeta>>(new Map());

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

  function open(next: string) {
    const value = next.trim();
    if (!value) return;
    if (stack.length === 1 && stack[0] === value) setReload(count => count + 1);
    else navigate([value]);
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

  const current = id ? metas.get(id) ?? null : null;
  const parentId = stack.length > 1 ? stack.at(-2)! : current?.kind === 'subagent' ? current.parentId : null;
  const parentName = parentId ? metas.get(parentId)?.name ?? null : null;
  const trigger = !id ? '选择会话'
    : current === null ? sessionLabel(null, id)
      : current.kind === 'subagent' ? subagentLabel(current)
        : sessionLabel(current.name, id);
  const detail = [current?.name, current?.agentPath, id].filter(Boolean).join(' · ') || '切换会话';

  return <main className="shell">
    <header className="session-bar">
      <div className="session-bar-main">
        <h1>Codex 轨迹</h1>
        <Dropdown className="session-trigger" ariaLabel="切换会话" title={detail}
          minWidth={300} maxWidth={520} label={<span className="session-trigger-name">{trigger}</span>}>
          {close => <SessionMenu current={id} choose={choose => { close(); open(choose); }} />}
        </Dropdown>
        {embedded && hostSession && id === hostSession ? <span className="session-badge">当前聊天</span> : null}
        {current?.kind === 'subagent' ? <span className="session-badge session-badge-agent">子代理</span> : null}
      </div>
      <div className="session-bar-actions">
        {stack.length > 1
          ? <button type="button" onClick={backToParent} title={parentName ? `返回「${parentName}」` : undefined}>返回父会话</button>
          : current?.kind === 'subagent' && current.parentId
            ? <button type="button" onClick={() => navigate([current.parentId!])}>打开父会话</button>
            : null}
      </div>
    </header>
    <div className="session-stack">
      {stack.map((session, index) => {
        const active = index === stack.length - 1;
        return <div className="session-layer" key={session + ':' + reload} data-active={active}
          aria-hidden={!active || undefined} inert={!active || undefined}>
          <LoadedSession id={session} active={active} openAgent={inspectAgent} />
        </div>;
      })}
      {stack.length === 0 ? <p className="empty">从上方选择会话，或按会话 ID 打开。</p> : null}
    </div>
  </main>;
}
