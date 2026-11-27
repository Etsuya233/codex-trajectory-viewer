import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentLink, SearchPage, SessionChoice, SessionStats, TrajectoryEvent } from '../model.ts';
import { errorMessage, queryUrl, request, sessionUrl } from './api.ts';

function shortId(id: string) {
  return id.slice(0, 8);
}

function formatWhen(value: string) {
  const text = value.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace('T', ' ');
  return date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** The parent log usually records only a path; the child meta supplies the nickname. */
export function agentLabel(agent: AgentLink) {
  const name = agent.name?.trim();
  const path = agent.path?.trim();
  if (name && path) return `${name} · ${path}`;
  return name || path || agent.label;
}

export function sessionLabel(name: string | null | undefined, id: string) {
  return name?.trim() || id.slice(0, 8);
}

interface AgentMenuProps {
  id: string;
  generation: string;
  revision: number;
  openAgent: (id: string) => void;
  close: () => void;
}

export function AgentMenu({ id, generation, revision, openAgent, close }: AgentMenuProps) {
  const [agents, setAgents] = useState<AgentLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!generation) return;
    const abort = new AbortController();
    const url = queryUrl(sessionUrl(id) + '/agents', { generation });
    request<AgentLink[]>(url, abort.signal).then(entries => {
      if (abort.signal.aborted) return;
      setAgents(entries);
      setError(null);
    }).catch(cause => {
      if (!abort.signal.aborted) setError(errorMessage(cause));
    });
    return () => abort.abort();
  }, [generation, id, revision, attempt]);

  if (error) {
    return <p className="menu-state" role="alert">
      {error} <button type="button" onClick={() => {
        setError(null);
        setAttempt(value => value + 1);
      }}>重试</button>
    </p>;
  }
  if (agents === null) {
    return <p className="menu-state" role="status">{generation ? '正在读取子代理…' : '正在索引历史…'}</p>;
  }
  if (agents.length === 0) return <p className="menu-state">当前会话暂无子代理。</p>;
  const firstOption = agents.findIndex(agent => agent.id);
  return <>
    <div className="menu-heading">子代理<span className="menu-count">{agents.length}</span></div>
    <ul className="menu-list" aria-label="子代理列表">
      {agents.map((agent, index) => <li key={agent.id ?? index}>
        {agent.id
          ? <button type="button" className="menu-option" data-dropdown-option autoFocus={index === firstOption}
            title={agent.id} onClick={() => { close(); openAgent(agent.id!); }}>
            <span className="menu-option-main">{agentLabel(agent)}</span>
            <span className="menu-option-meta">{shortId(agent.id)}{agent.role ? ` · ${agent.role}` : ''}</span>
          </button>
          : <span className="menu-option" aria-disabled="true">
            <span className="menu-option-main">{agentLabel(agent)}</span>
            <span className="menu-option-meta">无可用会话 ID</span>
          </span>}
      </li>)}
    </ul>
  </>;
}

interface SessionMenuProps {
  current: string;
  choose: (id: string) => void;
}

export function SessionMenu({ current, choose }: SessionMenuProps) {
  const [term, setTerm] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [choices, setChoices] = useState<SessionChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [manual, setManual] = useState('');
  const inputId = useId();

  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      setBusy(true);
      request<SessionChoice[]>(queryUrl('/api/sessions', { q: term }), abort.signal).then(items => {
        if (abort.signal.aborted) return;
        setChoices(items);
        setError(null);
      }).catch(cause => {
        if (!abort.signal.aborted) setError(errorMessage(cause));
      }).finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    }, 160);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [attempt, term]);

  const openById = (event: FormEvent) => {
    event.preventDefault();
    const id = manual.trim();
    if (id) choose(id);
  };

  return <>
    <div className="menu-search">
      <input autoFocus type="search" aria-label="搜索会话名或 ID" placeholder="搜索会话名或 ID"
        value={term} spellCheck={false} autoComplete="off"
        onChange={event => { setTerm(event.currentTarget.value); setError(null); }}
        onKeyDown={event => {
          if (event.key === 'Enter' && choices?.[0]) {
            event.preventDefault();
            choose(choices[0].id);
          }
        }} />
    </div>
    {error
      ? <p className="menu-state" role="alert">{error} <button type="button" onClick={() => {
        setError(null);
        setAttempt(value => value + 1);
      }}>重试</button></p>
      : choices === null
        ? <p className="menu-state" role="status">正在查找会话…</p>
        : choices.length === 0
          ? <p className="menu-state">找不到匹配的会话。</p>
          : <ul className="menu-list" role="listbox" aria-label="会话列表">
            {choices.map(item => <li key={item.id} role="presentation">
              <button type="button" role="option" aria-selected={item.id === current}
                className="menu-option" data-dropdown-option title={item.id} onClick={() => choose(item.id)}>
                <span className="menu-option-main">
                  {item.id === current ? <span className="menu-current" aria-hidden="true">✓ </span> : null}
                  {sessionLabel(item.name, item.id)}
                </span>
                <span className="menu-option-meta">
                  {formatWhen(item.updatedAt ?? item.date)}{item.archived ? ' · 已归档' : ''} · {shortId(item.id)}
                </span>
              </button>
            </li>)}
          </ul>}
    {busy && choices !== null ? <p className="menu-busy" role="status">正在筛选…</p> : null}
    <form className="menu-footer" onSubmit={openById}>
      <label className="menu-footer-label" htmlFor={inputId}>按会话 ID 打开（含子代理）</label>
      <div className="menu-footer-row">
        <input id={inputId} value={manual} spellCheck={false} autoComplete="off"
          placeholder="会话 UUID" aria-label="会话 ID"
          onChange={event => setManual(event.currentTarget.value)} />
        <button type="submit" disabled={!manual.trim()}>打开</button>
      </div>
    </form>
  </>;
}

interface SearchProps {
  id: string;
  generation: string;
  term: string;
  tool: string;
  errors: boolean;
  select: (event: TrajectoryEvent) => void;
  disabled: boolean;
}

export function SessionSearch({ id, generation, term, tool, errors, select, disabled }: SearchProps) {
  const [cursors, setCursors] = useState<(number | undefined)[]>([undefined]);
  const before = cursors.at(-1);
  const [results, setResults] = useState<SearchPage | null>(null);
  const [retry, setRetry] = useState(0);
  const [fault, setFault] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    if (!(term.trim() || tool.trim() || errors)) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      const url = queryUrl(sessionUrl(id) + '/search', { q: term, tool, errors: errors ? 1 : undefined, before, generation });
      request<SearchPage>(url, abort.signal).then(page => {
        if (abort.signal.aborted) return;
        setResults(page);
        setBusy(false);
      }).catch(cause => {
        if (abort.signal.aborted) return;
        setFault(errorMessage(cause));
        setBusy(false);
      });
    }, 220);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [id, generation, term, tool, errors, before, retry]);
  if (!(term.trim() || tool.trim() || errors)) return <p className="search-strip">输入搜索词或设置工具筛选。</p>;
  return <section className="search-strip" aria-label="全会话搜索结果">
    {results ? <ol>{results.events.map(event => <li key={event.source.offset}>
      <button type="button" disabled={disabled} onClick={() => select(event)}><strong>{event.label}</strong> {event.preview}</button>
    </li>)}</ol> : null}
    {busy ? <p role="status">正在搜索整个会话…</p> : null}
    {fault ? <p role="alert">{fault} <button type="button" onClick={() => {
      setFault(null); setBusy(true); setRetry(value => value + 1);
    }}>重试搜索</button></p> : null}
    {!busy && results?.events.length === 0 ? <p>会话没有匹配的记录。</p> : null}
    {!busy && cursors.length > 1 ? <button type="button" onClick={() => {
      setBusy(true); setFault(null); setCursors(current => current.slice(0, -1));
    }}>上一页搜索结果</button> : null}
    {!busy && !fault && results?.next != null ? <button type="button" onClick={() => {
      setBusy(true); setCursors(current => [...current, results.next!]);
    }}>下一页搜索结果</button> : null}
  </section>;
}

export function Statistics({ id, revision }: { id: string; revision: number }) {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    request<SessionStats>(sessionUrl(id) + '/stats', abort.signal).then(setStats).catch(cause => {
      if (!abort.signal.aborted) setError(errorMessage(cause));
    });
    return () => abort.abort();
  }, [id, revision, retry]);
  if (error) return <p role="alert" className="stats stats-fault">{error} <button type="button" onClick={() => {
    setError(null); setRetry(value => value + 1);
  }}>重试统计</button></p>;
  if (!stats) return <p role="status" className="stats stats-fault">正在读取会话统计…</p>;
  const count = (value: number | null) => value?.toLocaleString('zh-CN') ?? '未知';
  const source = stats.source === 'response-usage' ? '逐响应记录'
    : stats.source === 'reported-cumulative' ? '最新累计快照' : '无可确认 Token 来源';
  return <section className="stats" aria-label="当前会话统计">
    <div className="stats-item">
      <span className="stats-label">日志来源</span>
      <span className="stats-value">{source}</span>
    </div>
    <div className="stats-item">
      <span className="stats-label">Token</span>
      <span className="stats-value">{count(stats.totalTokens)}</span>
    </div>
    <div className="stats-item stats-item-wide">
      <span className="stats-label">输入</span><span className="stats-value">{count(stats.inputTokens)}</span>
      <span className="stats-label">缓存</span><span className="stats-value">{count(stats.cachedInputTokens)}</span>
      <span className="stats-label">输出</span><span className="stats-value">{count(stats.outputTokens)}</span>
      <span className="stats-label">推理</span><span className="stats-value">{count(stats.reasoningOutputTokens)}</span>
    </div>
    <div className="stats-item">
      <span className="stats-label">轮次耗时</span>
      <span className="stats-value">{stats.durationMs === null ? '未知' : `${count(stats.durationMs)} ms`}</span>
      <span className="stats-note">有耗时 {stats.recordedTimedTurns}/{stats.completedTurns}</span>
    </div>
  </section>;
}
