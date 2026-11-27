import { useEffect, useState } from 'react';
import type { SearchPage, SessionChoice, SessionStats, TrajectoryEvent } from '../model.ts';
import { errorMessage, queryUrl, request, sessionUrl } from './api.ts';

export function SessionPicker({ choose }: { choose: (id: string) => void }) {
  const [term, setTerm] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [choices, setChoices] = useState<SessionChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      request<SessionChoice[]>(queryUrl('/api/sessions', { q: term }), abort.signal).then(setChoices).catch(cause => {
        if (!abort.signal.aborted) setError(errorMessage(cause));
      });
    }, 180);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [term, attempt]);
  return <div className="session-picker" aria-label="会话列表">
    <input type="search" aria-label="筛选会话 ID" placeholder="筛选会话 ID" value={term}
      onChange={event => { setTerm(event.currentTarget.value); setChoices(null); setError(null); }} />
    {error ? <p role="alert">{error} <button type="button" onClick={() => { setError(null); setAttempt(value => value + 1); }}>重试</button></p>
      : choices === null ? <p role="status">正在查找会话…</p>
        : choices.length === 0 ? <p>找不到匹配的会话。</p>
          : <ul>{choices.map(item => <li key={item.id}>
            <button type="button" onClick={() => choose(item.id)}>
              <span>{item.id}</span> <small>{item.date.replace('T', ' ')}{item.archived ? ' · 已归档' : ''}</small>
            </button>
          </li>)}</ul>}
  </div>;
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
  if (error) return <p role="alert" className="search-strip">{error} <button type="button" onClick={() => {
    setError(null); setRetry(value => value + 1);
  }}>重试统计</button></p>;
  if (!stats) return <p role="status" className="search-strip">正在读取会话统计…</p>;
  const count = (value: number | null) => value?.toLocaleString('zh-CN') ?? '未知';
  const source = stats.source === 'response-usage' ? '逐响应记录' : stats.source === 'reported-cumulative' ? '最新累计快照' : '无可确认 Token 来源';
  return <section className="search-strip stats" aria-label="当前会话统计">
    <span>本会话日志 · {source}</span>
    <span>Token {count(stats.totalTokens)}</span>
    <span>输入 {count(stats.inputTokens)} · 缓存 {count(stats.cachedInputTokens)} · 输出 {count(stats.outputTokens)} · 推理 {count(stats.reasoningOutputTokens)}</span>
    <span>轮次耗时 {stats.durationMs === null ? '未知' : `${count(stats.durationMs)} ms`}（有耗时 {stats.recordedTimedTurns}/{stats.completedTurns}）</span>
  </section>;
}
