import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { DetailField, DetailPage, EventKind, Source, TrajectoryEvent, TrajectoryPage } from '../model.ts';
import { TrajectoryTimeline } from './dsh/TrajectoryTimeline.tsx';
import { trajectoryTimelineFocusIndexes } from './dsh/timeline.ts';
import type { TrajectoryTimeRange, TrajectoryTimelineMode } from './dsh/timeline.ts';
import type { TrajectoryTurnModel } from './dsh/layout.ts';
import type { TrajectoryCellKind } from './dsh/trajectory-record.ts';
import { translate } from './dsh/locales.ts';
import ledger from './dsh/TrajectoryTable.module.css';
import toolbar from './dsh/TrajectoryToolbar.module.css';

const kindStyles: Record<EventKind, { name: string; glyph: string; style: string; lane: TrajectoryCellKind }> = {
  user: { name: '用户', glyph: '人', style: ledger.user, lane: 'user' },
  assistant: { name: '助手', glyph: '✦', style: ledger.message, lane: 'message' },
  reasoning: { name: '摘要', glyph: '·', style: ledger.message, lane: 'message' },
  tool: { name: '工具', glyph: '↗', style: ledger.toolAmber, lane: 'tool' },
  result: { name: '结果', glyph: '↳', style: ledger.toolAmber, lane: 'tool' },
  compaction: { name: '压缩', glyph: '⇥', style: ledger.compacted, lane: 'compacted' },
  unknown: { name: '事件', glyph: '…', style: ledger.systemNeutral, lane: 'system' },
  error: { name: '错误', glyph: '!', style: ledger.systemNeutral, lane: 'system' },
};

function hasError(event: TrajectoryEvent) {
  return event.kind === 'error' || event.result?.status === 'error';
}

function timeValue(timestamp: string | null) {
  const milliseconds = timestamp === null ? NaN : Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function sessionUrl(id: string) {
  return '/api/sessions/' + encodeURIComponent(id);
}

async function request<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '无法加载本地轨迹。');
  return body;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '无法读取记录。';
}

function KindTag({ event }: { event: TrajectoryEvent }) {
  const { name, glyph, style } = kindStyles[event.kind];
  return (
    <span className={`${ledger.kindTag} ${style} ${hasError(event) ? ledger.error : ''}`} aria-label={name}>
      <span className={ledger.kindTagIcon} aria-hidden="true">{glyph}</span>
      <span className={ledger.kindTagLabel} aria-hidden="true">{name}</span>
    </span>
  );
}

function Status({ event }: { event: TrajectoryEvent }) {
  const state = event.result?.status;
  if (event.kind !== 'tool' && state === undefined) return null;
  const labels = { returned: '已返回', error: '错误', running: '后台运行中' };
  return <span className={state === 'error' ? ledger.error : undefined}>{state ? labels[state] : '未见结果'}</span>;
}

function Content({ event }: { event: TrajectoryEvent }) {
  if (event.kind === 'tool') {
    return (
      <span className={event.result ? ledger.resultPreview : ledger.contentText}>
        <span className={ledger.resultRequest}>
          <strong className={ledger.toolCallNameTypeface}>{event.label}</strong>
          {event.preview ? <span className={ledger.toolCallPayload}> {event.preview}</span> : null}
        </span>
        {event.result
          ? <span className={`${ledger.inlineResult} ${hasError(event) ? ledger.error : ''}`}>
              <span className={ledger.arrow}>→</span>
              <span className={ledger.inlineResultText}>{event.result.preview || '空结果'}</span>
            </span>
          : null}
      </span>
    );
  }
  return <span className={ledger.contentText}>{event.preview || event.problem || event.label}</span>;
}

interface InspectorTab {
  label: string;
  source: Source;
  field: DetailField;
}

function Inspector({ id, event, close }: { id: string; event: TrajectoryEvent; close: () => void }) {
  const tabs: InspectorTab[] = [];
  if (event.kind !== 'unknown') tabs.push({
    label: event.kind === 'tool' ? '参数' : event.kind === 'result' ? '结果' : event.kind === 'reasoning' ? '思考摘要' : '内容',
    source: event.source,
    field: 'content',
  });
  if (event.kind === 'tool' && event.result) tabs.push({ label: '结果', source: event.result.source, field: 'content' });
  tabs.push({ label: '原始记录', source: event.source, field: 'raw' });
  if (event.kind === 'tool' && event.result) tabs.push({ label: '原始结果', source: event.result.source, field: 'raw' });
  const [active, setActive] = useState(0);
  const tab = tabs[active];
  const timestamp = timeValue(event.timestamp);

  return (
    <aside className={ledger.details} aria-label="记录详情">
      <header className={ledger.detailsHeader}>
        <div className={ledger.detailsTitle}>
          <KindTag event={event} />
          <span className={ledger.detailsLocation} title={event.label}>{event.label}</span>
        </div>
        <button type="button" className={ledger.close} onClick={close} aria-label="关闭详情">×</button>
      </header>
      <div className="record-meta">
        {timestamp === null ? '无时间戳' : new Date(timestamp).toLocaleString('zh-CN', { hour12: false })}
        <Status event={event} />
        <span title="原始日志字节偏移">字节 {tab.source.offset.toLocaleString('zh-CN')}</span>
      </div>
      <div className={ledger.detailTabs} aria-label="详情视图">
        {tabs.map((entry, index) => (
          <button type="button" key={entry.label} className={`${ledger.detailTab} ${index === active ? ledger.detailTabActive : ''}`}
            aria-pressed={index === active} onClick={() => setActive(index)}>{entry.label}</button>
        ))}
      </div>
      <Payload key={active} id={id} tab={tab} />
    </aside>
  );
}

function Payload({ id, tab }: { id: string; tab: InspectorTab }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [page, setPage] = useState<DetailPage>({ text: '', next: 0 });
  const [from, setFrom] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const { offset, length, digest } = tab.source;

  useEffect(() => {
    const abort = new AbortController();
    const query = new URLSearchParams({ offset: String(offset), length: String(length), digest, field: tab.field, from: String(from) });
    request<DetailPage>(`${sessionUrl(id)}/detail?${query}`, abort.signal)
      .then(next => {
        setPage(current => ({ text: from === 0 ? next.text : current.text + next.text, next: next.next }));
        setStatus('ready');
      })
      .catch(cause => {
        if (abort.signal.aborted) return;
        setError(errorMessage(cause));
        setStatus('error');
      });
    return () => abort.abort();
  }, [id, offset, length, digest, tab.field, from, attempt]);

  return (
    <div className="payload">
      {page.text ? <pre data-testid="payload-text">{page.text}</pre> : null}
      {status === 'ready' && !page.text ? <p>此记录没有可显示的内容。</p> : null}
      {status === 'ready' && page.next !== null ? (
        <button type="button" onClick={() => { setStatus('loading'); setFrom(page.next!); }}>加载更多内容</button>
      ) : null}
      {status === 'loading' ? <p role="status">正在读取详情…</p> : null}
      {status === 'error' ? <p role="alert">{error} <button type="button" onClick={() => {
        setStatus('loading');
        setAttempt(current => current + 1);
      }}>重试</button></p> : null}
    </div>
  );
}

interface Group {
  key: string;
  turn: string | null;
  events: TrajectoryEvent[];
}

function groupEvents(events: TrajectoryEvent[]): Group[] {
  const groups: Group[] = [];
  for (const event of events) {
    const current = groups.at(-1);
    if (current?.turn === event.turn) {
      current.events.push(event);
    } else {
      groups.push({ key: String(event.source.offset), turn: event.turn, events: [event] });
    }
  }
  return groups;
}

function Trajectory({ id, page }: { id: string; page: TrajectoryPage }) {
  const groups = useMemo(() => groupEvents(page.events), [page.events]);
  const [selected, setSelected] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [mode, setMode] = useState<TrajectoryTimelineMode>('sequence');
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const rows = useRef(new Map<number, HTMLElement>());
  const pendingFocus = useRef<number | null>(null);
  const event = page.events.find(item => item.source.offset === selected);
  const hasQuery = query.trim() !== '' || errorsOnly;
  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    return new Set(page.events.filter(item => (!errorsOnly || hasError(item)) &&
      `${item.label} ${item.preview} ${item.result?.preview ?? ''}`.toLowerCase().includes(term))
      .map(item => item.source.offset));
  }, [errorsOnly, page.events, query]);
  const timeline = useMemo<TrajectoryTurnModel[]>(() => groups.map((group, index) => ({
    turn: group.turn === null ? null : index + 1,
    groups: [{ cells: group.events.map(item => ({
      index: item.source.offset,
      kind: kindStyles[item.kind].lane,
      text: item.label,
      isError: hasError(item),
      startedAt: timeValue(item.timestamp),
      timeSeconds: null,
    })) }],
  })), [groups]);
  const focused = useMemo(() => range === null ? null : trajectoryTimelineFocusIndexes(timeline, range, mode),
    [timeline, range, mode]);

  useLayoutEffect(() => {
    if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }, []);

  useEffect(() => {
    if (new URLSearchParams(location.search).get('measure') !== '1') return;
    const apiUrl = new URL(sessionUrl(id), location.href).href;
    const api = performance.getEntriesByName(apiUrl, 'resource').at(-1);
    const committed = performance.now();
    // Wait through one browser paint opportunity before recording a visible-ledger metric.
    let painted = 0;
    const first = requestAnimationFrame(() => {
      painted = requestAnimationFrame(() => {
        if (table.current) {
          table.current.dataset.firstRowsMs = String(Math.round(performance.now()));
          table.current.dataset.renderCommittedMs = String(Math.round(committed));
          table.current.dataset.summaryRequestMs = api ? String(Math.round(api.duration)) : '';
          table.current.dataset.visibility = document.visibilityState;
        }
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(painted);
    };
  }, [id]);

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target !== null) {
      rows.current.get(target)?.scrollIntoView({ block: 'nearest' });
      pendingFocus.current = null;
    }
  }, [collapsed, query, errorsOnly, selected]);

  const focus = useCallback((offset: number) => {
    const group = groups.find(item => item.events.some(row => row.source.offset === offset));
    const currentRow = rows.current.get(offset);
    if (currentRow) currentRow.scrollIntoView({ block: 'nearest' });
    else if (group) {
      pendingFocus.current = offset;
      setCollapsed(current => {
        const next = new Set(current);
        next.delete(group.key);
        return next;
      });
      if (!matches.has(offset)) {
        setQuery('');
        setErrorsOnly(false);
      }
    }
  }, [groups, matches]);

  const selectTimeline = useCallback((offset: number) => {
    setSelected(offset);
    focus(offset);
  }, [focus]);

  const close = () => {
    if (selected !== null) rows.current.get(selected)?.focus();
    setSelected(null);
  };

  return (
    <>
      <section className={toolbar.root} aria-label="轨迹工具栏">
        <div className={toolbar.inner}>
          <div className={toolbar.actions}>
            <button className={toolbar.toggle} type="button" aria-pressed={mode === 'sequence'}
              onClick={() => { setMode('sequence'); setRange(null); }}>事件顺序</button>
            <button className={toolbar.toggle} type="button" aria-pressed={mode === 'actual'}
              onClick={() => { setMode('actual'); setRange(null); }}>记录时间</button>
            <button className={toolbar.toggle} type="button" aria-pressed={errorsOnly}
              onClick={() => setErrorsOnly(current => !current)}>仅错误</button>
          </div>
          <input className="trajectory-search" type="search" aria-label="搜索已加载的摘要" placeholder="搜索已加载的摘要"
            value={query} onChange={e => setQuery(e.currentTarget.value)} />
          <span className="record-count" role="status">{hasQuery ? `${matches.size} / ` : ''}{page.events.length} 条记录</span>
          {page.scanLimited ? <span className="record-count">已达日志尾部读取上限，部分历史可能省略。</span> : null}
        </div>
      </section>
      <TrajectoryTimeline t={translate} turns={timeline} mode={mode} range={range} onRangeChange={setRange}
        selectedIndex={selected} searchMatchIndexes={hasQuery ? matches : null} onRecordFocus={focus} onRecordSelect={selectTimeline} />
      <div className={ledger.split} onKeyDown={e => { if (e.key === 'Escape' && event) close(); }}>
        <div ref={pane} className={ledger.tablePane}>
          <table ref={table} className={ledger.table} data-scroll-ready="true" aria-label="会话轨迹">
            <colgroup><col className={ledger.eventColumn} /><col className={ledger.contentColumn} /></colgroup>
            <thead><tr><th className={ledger.eventHeader} scope="col">事件</th><th scope="col">内容</th></tr></thead>
            <tbody>
              {page.earlier ? <tr data-history-load className={ledger.historyLoadRow}><td colSpan={2} className="history-note">显示最近记录</td></tr> : null}
              {groups.map(group => {
                const visible = group.events.filter(item => matches.has(item.source.offset));
                if (visible.length === 0) return null;
                const folded = collapsed.has(group.key);
                const groupLabel = group.turn ? '轮次 ' + group.turn.slice(0, 8) : '轮次未知';
                return (
                  <Fragment key={group.key}>
                    <tr className="turn-heading" data-collapsed-summary>
                      <td colSpan={2}>
                        <button type="button" aria-expanded={!folded} onClick={() => setCollapsed(current => {
                          const next = new Set(current);
                          if (next.has(group.key)) next.delete(group.key);
                          else next.add(group.key);
                          return next;
                        })}><span aria-hidden="true">{folded ? '▸' : '▾'}</span> {groupLabel} <span className="turn-count">{visible.length} 条</span></button>
                      </td>
                    </tr>
                    {!folded ? visible.map(item => {
                      const offset = item.source.offset;
                      const outside = focused !== null && !focused.has(offset);
                      return (
                        <tr key={offset} tabIndex={0} data-kind={item.kind} data-selected={offset === selected || undefined}
                          data-trajectory-record="" data-timeline-focus={outside ? 'outside' : undefined}
                          ref={node => { if (node) rows.current.set(offset, node); else rows.current.delete(offset); }}
                          onClick={() => setSelected(offset)} onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(offset); }
                          }}>
                          <td className={ledger.event}><div className={ledger.eventInner}><KindTag event={item} /></div></td>
                          <td className={ledger.content}><Content event={item} /></td>
                        </tr>
                      );
                    }) : null}
                  </Fragment>
                );
              })}
              {matches.size === 0 ? <tr><td colSpan={2} className="history-note">{hasQuery ? '没有匹配的记录。' : '没有可显示的完整记录。'}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {event ? <Inspector key={event.source.offset} id={id} event={event} close={close} /> : null}
      </div>
    </>
  );
}

function LoadedSession({ id }: { id: string }) {
  const [state, setState] = useState<{ page?: TrajectoryPage; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    request<TrajectoryPage>(sessionUrl(id), abort.signal)
      .then(page => setState({ page }))
      .catch(cause => { if (!abort.signal.aborted) setState({ error: errorMessage(cause) }); });
    return () => abort.abort();
  }, [id, attempt]);

  if (state.page) return <Trajectory id={id} page={state.page} />;
  if (state.error) return <p className="empty" role="alert">{state.error} <button type="button" onClick={() => {
    setState({});
    setAttempt(current => current + 1);
  }}>重试</button></p>;
  return <p className="empty" role="status">正在定位会话并读取最近记录…</p>;
}

const initialSession = new URLSearchParams(location.search).get('session') ?? '';

export function App() {
  const [id, setId] = useState(initialSession);
  const [input, setInput] = useState(initialSession);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const navigate = () => {
      const session = new URLSearchParams(location.search).get('session') ?? '';
      setId(session);
      setInput(session);
    };
    window.addEventListener('popstate', navigate);
    return () => window.removeEventListener('popstate', navigate);
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = input.trim();
    if (!next) return;
    const url = new URL(location.href);
    url.searchParams.set('session', next);
    if (next !== id) history.pushState(null, '', url);
    setId(next);
    setInput(next);
    setReload(current => current + 1);
  }

  return (
    <main className="shell">
      <header className="session-bar">
        <h1>Codex 轨迹</h1>
        <form onSubmit={submit} aria-label="打开会话">
          <input value={input} onChange={e => setInput(e.currentTarget.value)} placeholder="会话 ID"
            aria-label="会话 ID" required spellCheck={false} autoComplete="off" />
          <button type="submit">打开</button>
        </form>
      </header>
      {id ? <LoadedSession key={`${id}:${reload}`} id={id} /> : <p className="empty">输入 Codex 会话 ID 以查看轨迹。</p>}
    </main>
  );
}
