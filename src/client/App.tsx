import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { SessionPicker } from './SessionTools.tsx';
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

interface AppProps {
  embedded?: boolean;
  hostSession?: string;
}

export function App({ embedded = false, hostSession }: AppProps) {
  const [stack, setStack] = useState(() => embedded ? hostSession ? [hostSession] : [] : currentStack());
  const id = stack.at(-1) ?? '';
  const [input, setInput] = useState(id);
  const [picker, setPicker] = useState(embedded && !hostSession);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (embedded) return;
    const navigate = () => {
      const next = currentStack();
      setStack(next);
      setInput(next.at(-1) ?? '');
      setPicker(false);
    };
    window.addEventListener('popstate', navigate);
    return () => window.removeEventListener('popstate', navigate);
  }, [embedded]);

  function navigate(next: string[]) {
    if (!embedded) storeStack(next);
    setStack(next);
    setInput(next.at(-1) ?? '');
    setPicker(false);
  }

  function open(id: string) {
    if (stack.length === 1 && stack[0] === id) {
      setReload(value => value + 1);
      setPicker(false);
    } else navigate([id]);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = input.trim();
    if (next) open(next);
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

  return <main className="shell">
    <header className="session-bar">
      <h1>Codex 轨迹</h1>
      {embedded && hostSession && id === hostSession ? <span className="record-count">当前聊天</span> : null}
      {stack.length > 1 ? <button type="button" onClick={backToParent}>返回父会话</button> : null}
      <form onSubmit={submit} aria-label="打开会话">
        <input value={input} onChange={event => setInput(event.currentTarget.value)} placeholder="会话 ID"
          aria-label="会话 ID" required spellCheck={false} autoComplete="off" />
        <button type="submit">打开</button>
      </form>
      <button type="button" aria-expanded={picker} onClick={() => setPicker(value => !value)}>选择会话</button>
    </header>
    {picker ? <SessionPicker choose={open} /> : null}
    <div className="session-stack">
      {stack.map((session, index) => {
        const active = index === stack.length - 1;
        return <div className="session-layer" key={session + ':' + reload} data-active={active}
          aria-hidden={!active || undefined} inert={!active || undefined}>
          <LoadedSession id={session} active={active} openAgent={inspectAgent} />
        </div>;
      })}
      {stack.length === 0 ? <p className="empty">输入 Codex 会话 ID 以查看轨迹。</p> : null}
    </div>
  </main>;
}
