import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IndexedPage, TrajectoryEvent } from '../model.ts';
import { sessionUrl } from './api.ts';
import { Content, hasError, Inspector, KindTag, kindStyles, timeValue } from './RecordView.tsx';
import { AgentMenu, SessionSearch, Statistics } from './SessionTools.tsx';
import { Dropdown } from './Dropdown.tsx';
import { TrajectoryTimeline } from './dsh/TrajectoryTimeline.tsx';
import { trajectoryTimelineFocusIndexes } from './dsh/timeline.ts';
import type { TrajectoryTimeRange, TrajectoryTimelineMode } from './dsh/timeline.ts';
import type { TrajectoryTurnModel } from './dsh/layout.ts';
import { translate } from './dsh/locales.ts';
import ledger from './dsh/TrajectoryTable.module.css';
import toolbar from './dsh/TrajectoryToolbar.module.css';

const ROW_HEIGHT = 30;
const OVERSCAN = 12;
const TIMELINE_LIMIT = 600;
const HISTORY_THRESHOLD = 120;

type Row = { key: string; items: TrajectoryEvent[]; folded: boolean; label: string } | { key: number; event: TrajectoryEvent };

interface Group { key: string; turn: string | null; events: TrajectoryEvent[] }

function groupEvents(events: TrajectoryEvent[]): Group[] {
  const groups: Group[] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (previous?.turn === event.turn) previous.events.push(event);
    else groups.push({ key: event.turn ?? 'unknown:' + event.source.offset, turn: event.turn, events: [event] });
  }
  return groups;
}

function makeTimeline(events: TrajectoryEvent[]): TrajectoryTurnModel[] {
  return groupEvents(events).map((group, index) => ({
    turn: group.turn === null ? null : index + 1,
    groups: [{ cells: group.events.map(item => ({
      index: item.source.offset,
      kind: kindStyles[item.kind].lane,
      text: item.label,
      isError: hasError(item),
      startedAt: timeValue(item.timestamp),
      timeSeconds: item.durationMs === undefined ? null : item.durationMs / 1000,
    })) }],
  }));
}

interface Props {
  id: string;
  page: IndexedPage;
  active: boolean;
  working: boolean;
  fault: string | null;
  fetchPage: (direction: 'before' | 'after' | 'around' | 'recent', offset?: number) => Promise<boolean>;
  openAgent: (id: string) => void;
}

export function Trajectory({ id, page, active, working, fault, fetchPage, openAgent }: Props) {
  const groups = useMemo(() => groupEvents(page.events), [page.events]);
  const [selected, setSelected] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [tool, setTool] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [scope, setScope] = useState<'loaded' | 'all'>('loaded');
  const [statistics, setStatistics] = useState(true);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [mode, setMode] = useState<TrajectoryTimelineMode>('sequence');
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  const [viewport, setViewport] = useState({ first: 0, count: 30 });
  const pane = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const oldRows = useRef<Row[]>([]);
  const follow = useRef(true);
  const previousTop = useRef(0);
  const earlierRequest = useRef<symbol | null>(null);
  const restoreFocus = useRef(false);
  const selectedEvent = page.events.find(event => event.source.offset === selected);
  const hasQuery = scope === 'loaded' && (query.trim() !== '' || tool.trim() !== '' || errorsOnly);

  const matches = useMemo(() => {
    if (!hasQuery) return null;
    const term = query.trim().toLowerCase();
    const toolName = tool.trim().toLowerCase();
    return new Set(page.events.filter(event =>
      (!errorsOnly || hasError(event))
      && (!toolName || (event.kind === 'tool' && event.label.toLowerCase().includes(toolName)))
      && `${event.label} ${event.preview} ${event.result?.preview ?? ''}`.toLowerCase().includes(term),
    ).map(event => event.source.offset));
  }, [hasQuery, errorsOnly, page.events, query, tool]);
  const rows = useMemo<Row[]>(() => groups.flatMap(group => {
    const items = matches === null ? group.events : group.events.filter(item => matches.has(item.source.offset));
    if (!items.length) return [];
    const folded = collapsed.has(group.key);
    const label = group.turn ? '轮次 ' + group.turn.slice(0, 8) : '轮次未知';
    return [{ key: group.key, items, folded, label }, ...(folded ? [] : items.map(event => ({ key: event.source.offset, event })))];
  }), [collapsed, groups, matches]);
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);

  const visibleMarker = rows[Math.min(viewport.first, rows.length - 1)]?.key;
  const modelStart = useMemo(() => {
    if (page.events.length <= TIMELINE_LIMIT) return 0;
    const marker = typeof visibleMarker === 'number' ? visibleMarker : rows[viewport.first + 1]?.key;
    const at = typeof marker === 'number' ? page.events.findIndex(item => item.source.offset === marker) : page.events.length - 1;
    const block = Math.max(0, Math.floor(at / 400) * 400 - 100);
    return Math.min(page.events.length - TIMELINE_LIMIT, block);
  }, [page.events, rows, viewport.first, visibleMarker]);
  const timeline = useMemo(() => makeTimeline(page.events.slice(modelStart, modelStart + TIMELINE_LIMIT)), [modelStart, page.events]);
  const focused = useMemo(() => range === null ? null : trajectoryTimelineFocusIndexes(timeline, range, mode),
    [timeline, range, mode]);

  const trackViewport = useCallback(() => {
    const element = pane.current;
    if (!element) return;
    const first = Math.floor(element.scrollTop / ROW_HEIGHT);
    const count = Math.ceil(element.clientHeight / ROW_HEIGHT);
    setViewport(previous => previous.first === first && previous.count === count ? previous : { first, count });
  }, []);

  function scrollTo(element: HTMLDivElement, top: number) {
    element.scrollTop = top;
    previousTop.current = element.scrollTop;
  }

  useLayoutEffect(() => () => { earlierRequest.current = null; }, [active]);

  useLayoutEffect(() => {
    const element = pane.current;
    if (!element || !active) return;
    const observer = new ResizeObserver(trackViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, trackViewport]);

  useLayoutEffect(() => {
    const element = pane.current;
    if (!element || !active) return;
    if (focusRequest !== null) {
      const index = rowIndex.get(focusRequest);
      if (index !== undefined) {
        scrollTo(element, index * ROW_HEIGHT);
        follow.current = false;
        setFocusRequest(null);
      }
    } else if (oldRows.current !== rows) {
      if (follow.current) scrollTo(element, element.scrollHeight);
      else {
        const previousIndex = Math.floor(element.scrollTop / ROW_HEIGHT);
        // A group header can stay at the top even when all its event rows move.
        const anchorIndex = oldRows.current.findIndex((row, index) =>
          index >= previousIndex && typeof row.key === 'number' && rowIndex.has(row.key));
        const index = anchorIndex < 0 ? previousIndex : anchorIndex;
        const key = oldRows.current[index]?.key;
        const nextIndex = key === undefined ? undefined : rowIndex.get(key);
        if (nextIndex !== undefined) scrollTo(element, element.scrollTop + (nextIndex - index) * ROW_HEIGHT);
      }
    }
    oldRows.current = rows;
    trackViewport();
  }, [active, focusRequest, rowIndex, rows, trackViewport]);

  useEffect(() => {
    if (!active || new URLSearchParams(location.search).get('measure') !== '1') return;
    const api = performance.getEntriesByName(new URL(sessionUrl(id), location.href).href, 'resource').at(-1);
    const committed = performance.now();
    let painted = 0;
    const first = requestAnimationFrame(() => {
      painted = requestAnimationFrame(() => {
        if (!table.current) return;
        const now = String(Math.round(performance.now()));
        if (!table.current.dataset.firstRowsMs) {
          table.current.dataset.firstRowsMs = now;
          table.current.dataset.renderCommittedMs = String(Math.round(committed));
          table.current.dataset.summaryRequestMs = api ? String(Math.round(api.duration)) : '';
          table.current.dataset.visibility = document.visibilityState;
        }
        if (!page.indexing && !table.current.dataset.indexedRowsMs) table.current.dataset.indexedRowsMs = now;
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(painted); };
  }, [active, id, page.indexing]);

  const focus = useCallback((offset: number) => {
    const group = groups.find(item => item.events.some(row => row.source.offset === offset));
    if (!group) return;
    setCollapsed(current => {
      if (!current.has(group.key)) return current;
      const next = new Set(current);
      next.delete(group.key);
      return next;
    });
    if (matches && !matches.has(offset)) {
      setQuery('');
      setTool('');
      setErrorsOnly(false);
    }
    setFocusRequest(offset);
  }, [groups, matches]);

  const selectTimeline = useCallback((offset: number) => {
    setSelected(offset);
    focus(offset);
  }, [focus]);

  async function loadEarlier(automatic = false) {
    if (!active || page.indexing || !page.earlier || working || earlierRequest.current !== null) return;
    if (automatic && (historyFailed || fault || hasQuery || scope !== 'loaded' || range !== null)) return;
    const request = Symbol();
    earlierRequest.current = request;
    follow.current = false;
    setHistoryFailed(false);
    const loaded = await fetchPage('before');
    if (earlierRequest.current === request) {
      earlierRequest.current = null;
      setHistoryFailed(!loaded);
    }
  }

  async function jump(event: TrajectoryEvent) {
    const offset = event.source.offset;
    if (!rowIndex.has(offset)) {
      follow.current = false;
      if (!await fetchPage('around', offset)) return;
      setCollapsed(new Set());
    }
    setSelected(offset);
    setFocusRequest(offset);
    setScope('loaded');
    setQuery('');
    setTool('');
    setErrorsOnly(false);
    setRange(null);
  }

  function close() {
    if (selected !== null) {
      const element = pane.current?.querySelector<HTMLElement>(`[data-row-offset="${selected}"]`);
      if (element) element.focus();
      else if (rowIndex.has(selected)) {
        restoreFocus.current = true;
        setFocusRequest(selected);
      }
    }
    setSelected(null);
  }

  useLayoutEffect(() => {
    if (!restoreFocus.current || focusRequest !== null) return;
    pane.current?.querySelector<HTMLElement>(`[data-row-offset="${rows[viewport.first]?.key}"]`)?.focus();
    restoreFocus.current = false;
  }, [focusRequest, rows, viewport.first]);

  // For the small initial snapshot keep the DOM stable. History uses a fixed-height virtual table.
  const start = rows.length <= 65 ? 0 : Math.max(0, viewport.first - OVERSCAN);
  const end = rows.length <= 65 ? rows.length : Math.min(rows.length, viewport.first + viewport.count + OVERSCAN);
  const spacer = (count: number) => count > 0 ? <tr className={ledger.virtualSpacer} data-virtual-spacer aria-hidden="true">
    <td colSpan={2} style={{ height: count * ROW_HEIGHT }} />
  </tr> : null;

  return <>
    <section className={toolbar.root} aria-label="轨迹工具栏">
      <div className={toolbar.inner}>
        <div className={toolbar.actions}>
          <button className={toolbar.toggle} type="button" aria-pressed={mode === 'sequence'}
            onClick={() => { setMode('sequence'); setRange(null); }}>事件顺序</button>
          <button className={toolbar.toggle} type="button" aria-pressed={mode === 'actual'}
            onClick={() => { setMode('actual'); setRange(null); }}>记录时间</button>
          <button className={toolbar.toggle} type="button" aria-pressed={errorsOnly}
            onClick={() => setErrorsOnly(current => !current)}>仅错误</button>
          <button className={toolbar.toggle} type="button" aria-pressed={statistics}
            onClick={() => setStatistics(current => !current)}>统计</button>
          <Dropdown className={`${toolbar.toggle} dropdown-trigger`} ariaLabel="子代理" title="子代理" active={active}
            minWidth={300} maxWidth={460} label={<span>子代理</span>}>
            {close => <AgentMenu id={id} generation={page.generation} revision={page.revision}
              openAgent={openAgent} close={close} />}
          </Dropdown>
        </div>
        <select aria-label="搜索范围" value={scope} onChange={event => setScope(event.currentTarget.value as typeof scope)}>
          <option value="loaded">已加载摘要</option><option value="all">全会话</option>
        </select>
        <input className="trajectory-search" type="search" aria-label={scope === 'loaded' ? '搜索已加载的摘要' : '搜索全会话'}
          placeholder={scope === 'loaded' ? '搜索已加载的摘要' : '搜索全会话'} value={query} onChange={e => setQuery(e.currentTarget.value)} />
        <input className="trajectory-search tool-filter" type="search" aria-label="筛选工具名"
          placeholder="工具名" value={tool} onChange={e => setTool(e.currentTarget.value)} />
        <span className="record-count" role="status">{matches ? `${matches.size} / ` : ''}{page.events.length} 条记录</span>
        {page.indexing ? <span className="record-count" role="status">正在索引历史…</span> : null}
        {page.scanLimited ? <span className="record-count">预览已达到日志尾部读取上限。</span> : null}
        {page.events.length > TIMELINE_LIMIT ? <span className="record-count">时间线覆盖滚动位置附近 {TIMELINE_LIMIT} 条</span> : null}
      </div>
    </section>
    {statistics && active ? <Statistics id={id} revision={page.revision} /> : null}
    {scope === 'all' && active ? <SessionSearch key={JSON.stringify([page.generation, query, tool, errorsOnly])} id={id}
      generation={page.generation} term={query} tool={tool}
      errors={errorsOnly} select={jump} disabled={working} /> : null}
    <TrajectoryTimeline t={translate} turns={timeline} mode={mode} range={range} onRangeChange={setRange}
      selectedIndex={selected} searchMatchIndexes={matches} onRecordFocus={focus} onRecordSelect={selectTimeline} />
    <div className="history-controls">
      <button type="button" disabled={page.indexing || working || !page.earlier}
        onClick={() => void loadEarlier()}>{historyFailed ? '重试加载更早' : '加载更早'}</button>
      {page.later ? <button type="button" disabled={working} onClick={() => void fetchPage('after')}>加载更新</button> : null}
      {page.later || !follow.current ? <button type="button" disabled={working} onClick={() => {
        follow.current = true;
        if (page.later) void fetchPage('recent');
        else if (pane.current) scrollTo(pane.current, pane.current.scrollHeight);
      }}>回到最新</button> : null}
      {working ? <span role="status">正在读取…</span> : null}
      {historyFailed ? <span role="alert">{fault ?? '无法加载更早的记录。'}</span>
        : fault ? <span role="alert">{fault} <button type="button" onClick={() => void fetchPage('recent')}>重试</button></span> : null}
    </div>
    <div className={ledger.split} onKeyDown={e => { if (e.key === 'Escape' && selectedEvent) close(); }}>
      <div ref={pane} className={`${ledger.tablePane} virtual-ledger`} onScroll={event => {
        const element = event.currentTarget;
        const top = element.scrollTop;
        const movingUp = top < previousTop.current;
        previousTop.current = top;
        follow.current = !page.later && element.scrollHeight - element.clientHeight - top < 6;
        trackViewport();
        if (movingUp && top <= HISTORY_THRESHOLD) void loadEarlier(true);
      }} onWheel={event => {
        const element = event.currentTarget;
        if (event.deltaY < 0 && element.scrollTop === 0 && element.scrollHeight > element.clientHeight) void loadEarlier(true);
      }}>
        <table ref={table} className={ledger.table} data-scroll-ready="true" aria-label="会话轨迹">
          <colgroup><col className={ledger.eventColumn} /><col className={ledger.contentColumn} /></colgroup>
          <thead><tr><th className={ledger.eventHeader} scope="col">事件</th><th scope="col">内容</th></tr></thead>
          <tbody>
            {spacer(start)}
            {rows.slice(start, end).map(row => 'items' in row ? (
              <tr key={row.key} className="turn-heading" data-collapsed-summary>
                <td colSpan={2}><button type="button" aria-expanded={!row.folded} onClick={() => setCollapsed(current => {
                  const next = new Set(current);
                  if (next.has(row.key)) next.delete(row.key);
                  else next.add(row.key);
                  return next;
                })}><span aria-hidden="true">{row.folded ? '▸' : '▾'}</span> {row.label} <span className="turn-count">{row.items.length} 条</span></button></td>
              </tr>
            ) : (
              <tr key={row.key} tabIndex={0} data-kind={row.event.kind} data-selected={row.key === selected || undefined}
                data-trajectory-record="" data-row-offset={row.key} data-timeline-focus={focused && !focused.has(row.key) ? 'outside' : undefined}
                onClick={() => setSelected(row.key)} onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(row.key); }
                }}>
                <td className={ledger.event}><div className={ledger.eventInner}><KindTag event={row.event} /></div></td>
                <td className={ledger.content}><Content event={row.event} /></td>
              </tr>
            ))}
            {spacer(rows.length - end)}
            {rows.length === 0 ? <tr><td colSpan={2} className="history-note">
              {hasQuery ? '没有匹配的记录。' : '没有可显示的完整记录。'}
            </td></tr> : null}
          </tbody>
        </table>
      </div>
      {selectedEvent && active ? <Inspector key={selectedEvent.source.offset} id={id} event={selectedEvent} close={close} openAgent={openAgent} /> : null}
    </div>
  </>;
}
