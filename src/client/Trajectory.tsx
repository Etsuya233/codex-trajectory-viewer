import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { IndexedPage, TrajectoryEvent } from '../model.ts';
import { sessionUrl } from './api.ts';
import { clockTime } from './format.ts';
import { Content, hasError, Inspector, KindTag, kindStyles, timeValue, toolCallSummary, toolRunSummary } from './RecordView.tsx';
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
const TOOL_RUN_MINIMUM = 3;

interface Group {
  key: string;
  turn: string | null;
  events: TrajectoryEvent[];
  ordinal: number | null;
  startedAt: number | null;
  errorCount: number;
}

type TurnRow = { key: string; items: TrajectoryEvent[]; folded: boolean; group: Group; turnKey: string };
type ToolRow = { key: string; events: TrajectoryEvent[]; turnKey: string; folded: boolean };
type EventRow = { key: number; event: TrajectoryEvent; turnKey: string };
type Row = TurnRow | ToolRow | EventRow;

function groupEvents(events: TrajectoryEvent[]): Group[] {
  const groups: Group[] = [];
  for (const event of events) {
    const previous = groups.at(-1);
    if (previous?.turn === event.turn) previous.events.push(event);
    else groups.push({
      key: event.turn ?? 'unknown:' + event.source.offset,
      turn: event.turn, events: [event], ordinal: null, startedAt: null, errorCount: 0,
    });
  }
  for (const group of groups) {
    group.ordinal = group.events.find(event => event.turnOrdinal !== undefined)?.turnOrdinal ?? null;
    for (const event of group.events) {
      const value = timeValue(event.timestamp);
      if (value !== null) {
        group.startedAt = value;
        break;
      }
    }
    group.errorCount = group.events.filter(hasError).length;
  }
  return groups;
}

function makeTimeline(events: TrajectoryEvent[]): TrajectoryTurnModel[] {
  return groupEvents(events).map((group, index) => ({
    turn: group.ordinal ?? (group.turn === null ? null : index + 1),
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

function turnLabel(group: Group) {
  return group.ordinal === null ? '轮次' : `第 ${group.ordinal} 轮`;
}

function narrowLayout() {
  return window.matchMedia?.('(max-width: 620px)').matches ?? false;
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
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [tool, setTool] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [scope, setScope] = useState<'loaded' | 'all'>('loaded');
  const [statistics, setStatistics] = useState(() => !narrowLayout());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [mode, setMode] = useState<TrajectoryTimelineMode>('sequence');
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  const [viewport, setViewport] = useState({ first: 0, count: 30 });
  const [following, setFollowing] = useState(true);
  const [newRecords, setNewRecords] = useState(0);
  const [reveal, setReveal] = useState<number | null>(null);
  const [turnHeaderVisible, setTurnHeaderVisible] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const oldRows = useRef<Row[]>([]);
  const follow = useRef(true);
  const previousTop = useRef(0);
  const earliestRequest = useRef<symbol | null>(null);
  const restoreFocus = useRef(false);
  const seenLatest = useRef<number | null>(null);
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
    const header: TurnRow = { key: group.key, items, folded, group, turnKey: group.key };
    if (folded) return [header];
    const body: Row[] = [];
    const canFoldTools = matches === null;
    for (let index = 0; index < items.length; index++) {
      const event = items[index];
      if (canFoldTools && event.kind === 'tool') {
        let end = index;
        while (end + 1 < items.length && items[end + 1].kind === 'tool') end++;
        if (end - index + 1 >= TOOL_RUN_MINIMUM) {
          const run = items.slice(index, end + 1);
          const key = 'tools:' + run[0].source.offset;
          const expanded = expandedTools.has(key) || run.some(item => item.source.offset === reveal);
          body.push({ key, events: run, turnKey: group.key, folded: !expanded });
          if (expanded) body.push(...run.map(item => ({ key: item.source.offset, event: item, turnKey: group.key })));
          index = end;
          continue;
        }
      }
      body.push({ key: event.source.offset, event, turnKey: group.key });
    }
    return [header, ...body];
  }), [collapsed, expandedTools, groups, matches, reveal]);
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const visibleGroups = useMemo(() => rows.filter((row): row is TurnRow => 'items' in row), [rows]);

  const visibleRow = rows[Math.min(viewport.first, rows.length - 1)];
  const currentGroup = useMemo(() => {
    if (!visibleRow) return groups.at(-1) ?? null;
    if ('items' in visibleRow) return visibleRow.group;
    return groups.find(group => group.key === visibleRow.turnKey) ?? null;
  }, [groups, visibleRow]);
  const currentTurnIndex = currentGroup ? visibleGroups.findIndex(row => row.key === currentGroup.key) : -1;
  const currentHeaderIndex = currentGroup ? rowIndex.get(currentGroup.key) : undefined;
  const currentCount = currentGroup
    ? matches === null ? currentGroup.events.length
      : currentGroup.events.filter(event => matches.has(event.source.offset)).length
    : 0;
  const turnBarVisible = currentGroup !== null && currentTurnIndex >= 0
    && currentHeaderIndex !== undefined && viewport.first > currentHeaderIndex && !turnHeaderVisible;

  const modelStart = useMemo(() => {
    if (page.events.length <= TIMELINE_LIMIT) return 0;
    const marker = visibleRow
      ? 'event' in visibleRow ? visibleRow.key
        : 'events' in visibleRow ? visibleRow.events[0]?.source.offset
          : visibleRow.items[0]?.source.offset
      : undefined;
    const at = typeof marker === 'number' ? page.events.findIndex(item => item.source.offset === marker) : page.events.length - 1;
    const block = Math.max(0, Math.floor(at / 400) * 400 - 100);
    return Math.min(page.events.length - TIMELINE_LIMIT, block);
  }, [page.events, visibleRow]);
  const timeline = useMemo(() => makeTimeline(page.events.slice(modelStart, modelStart + TIMELINE_LIMIT)),
    [modelStart, page.events]);
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

  useLayoutEffect(() => {
    const element = pane.current;
    if (!element || !currentGroup) {
      setTurnHeaderVisible(false);
      return;
    }
    const header = [...element.querySelectorAll<HTMLElement>('[data-turn-key]')]
      .find(node => node.dataset.turnKey === currentGroup.key);
    if (!header) {
      setTurnHeaderVisible(false);
      return;
    }
    const paneRect = element.getBoundingClientRect();
    const headRect = element.querySelector('thead')?.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const top = Math.max(paneRect.top, headRect?.bottom ?? paneRect.top);
    const visible = headerRect.bottom > top && headerRect.top < paneRect.bottom;
    setTurnHeaderVisible(current => current === visible ? current : visible);
  }, [currentGroup, rows, viewport]);

  const select = useCallback((offset: number) => {
    follow.current = false;
    setFollowing(false);
    setSelected(offset);
  }, []);

  useLayoutEffect(() => () => { earliestRequest.current = null; }, [active]);

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
        setFollowing(false);
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

  useEffect(() => {
    const media = window.matchMedia('(max-width: 620px)');
    const onChange = (event: MediaQueryListEvent) => {
      if (event.matches) setStatistics(false);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const latest = page.events.at(-1)?.source.offset ?? null;
    if (latest === null) {
      seenLatest.current = null;
      return;
    }
    if (seenLatest.current === null || following || latest <= seenLatest.current) {
      seenLatest.current = latest;
      setNewRecords(current => current === 0 ? current : 0);
      return;
    }
    let count = 0;
    for (const event of page.events) if (event.source.offset > seenLatest.current!) count++;
    seenLatest.current = latest;
    if (count > 0) setNewRecords(current => current + count);
  }, [following, page.events]);

  const focus = useCallback((offset: number) => {
    setReveal(null);
    const group = groups.find(item => item.events.some(row => row.source.offset === offset));
    if (!group) return;
    setCollapsed(current => {
      if (!current.has(group.key)) return current;
      const next = new Set(current);
      next.delete(group.key);
      return next;
    });
    const at = group.events.findIndex(item => item.source.offset === offset);
    if (at >= 0 && group.events[at].kind === 'tool') {
      let start = at;
      while (start > 0 && group.events[start - 1].kind === 'tool') start--;
      let end = at;
      while (end + 1 < group.events.length && group.events[end + 1].kind === 'tool') end++;
      if (end - start + 1 >= TOOL_RUN_MINIMUM) {
        const key = 'tools:' + group.events[start].source.offset;
        setExpandedTools(current => current.has(key) ? current : new Set(current).add(key));
      }
    }
    if (matches && !matches.has(offset)) {
      setQuery('');
      setTool('');
      setErrorsOnly(false);
    }
    follow.current = false;
    setFollowing(false);
    setFocusRequest(offset);
  }, [groups, matches]);

  const selectTimeline = useCallback((offset: number) => {
    setSelected(offset);
    focus(offset);
  }, [focus]);

  function toggleTools(key: string, expanded: boolean) {
    setReveal(null);
    setExpandedTools(current => {
      const next = new Set(current);
      if (expanded) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function loadEarlier(automatic = false) {
    if (!active || page.indexing || !page.earlier || working || earliestRequest.current !== null) return;
    if (automatic && (historyFailed || fault || hasQuery || scope !== 'loaded' || range !== null)) return;
    const request = Symbol();
    earliestRequest.current = request;
    follow.current = false;
    setFollowing(false);
    setHistoryFailed(false);
    const loaded = await fetchPage('before');
    if (earliestRequest.current === request) {
      earliestRequest.current = null;
      setHistoryFailed(!loaded);
    }
  }

  function returnToLatest() {
    follow.current = true;
    setFollowing(true);
    setNewRecords(0);
    seenLatest.current = page.events.at(-1)?.source.offset ?? null;
    if (page.later) void fetchPage('recent');
    else if (pane.current) scrollTo(pane.current, pane.current.scrollHeight);
  }

  function moveToGroup(index: number) {
    const target = visibleGroups[index];
    if (!target || !pane.current) return;
    const at = rowIndex.get(target.key);
    if (at === undefined) return;
    follow.current = false;
    setFollowing(false);
    scrollTo(pane.current, Math.max(0, at * ROW_HEIGHT - 30));
  }

  function moveTurn(delta: number) {
    if (currentTurnIndex < 0) return;
    moveToGroup(currentTurnIndex + delta);
  }

  async function jump(event: TrajectoryEvent) {
    const offset = event.source.offset;
    follow.current = false;
    setFollowing(false);
    if (!page.events.some(item => item.source.offset === offset)) {
      if (!await fetchPage('around', offset)) return;
      setCollapsed(new Set());
    } else {
      const group = groups.find(item => item.events.some(row => row.source.offset === offset));
      if (group) setCollapsed(current => {
        if (!current.has(group.key)) return current;
        const next = new Set(current);
        next.delete(group.key);
        return next;
      });
    }
    setReveal(offset);
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
  const liveState = fault ? 'fault' : working ? 'busy' : 'live';

  return <>
    <section className={toolbar.root} aria-label="轨迹工具栏">
      <div className={toolbar.inner}>
        <div className={`${toolbar.actions} toolbar-actions`}>
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
        <input className="trajectory-search" type="search" aria-label={scope === 'loaded' ? '搜索已加载的摘要' : '搜索全会话'}
          placeholder={scope === 'loaded' ? '搜索已加载的摘要' : '搜索全会话'} value={query} onChange={e => setQuery(e.currentTarget.value)} />
        <button type="button" className="filter-toggle" aria-expanded={filtersOpen}
          data-active={scope === 'all' || tool.trim() !== '' || errorsOnly ? 'true' : undefined}
          onClick={() => setFiltersOpen(current => !current)}>筛选</button>
        <div className="trajectory-filters" data-open={filtersOpen || undefined}>
          <select className="scope-select" aria-label="搜索范围" value={scope} onChange={event => setScope(event.currentTarget.value as typeof scope)}>
            <option value="loaded">已加载摘要</option><option value="all">全会话</option>
          </select>
          <input className="trajectory-search tool-filter" type="search" aria-label="筛选工具名"
            placeholder="工具名" value={tool} onChange={e => setTool(e.currentTarget.value)} />
        </div>
        <span className="record-count" role="status">{matches ? `${matches.size} / ` : ''}{page.events.length} 条记录</span>
        <span className="live-status" data-state={liveState} title={fault ? fault : '每 1.5 秒检查新记录'}>
          <span className="live-dot" aria-hidden="true" />{liveState === 'fault' ? '离线' : liveState === 'busy' ? '同步中' : '实时'}
        </span>
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
      {page.later || !following ? <button type="button" disabled={working} onClick={returnToLatest}>回到最新{newRecords ? ` (${newRecords})` : ''}</button> : null}
      {working ? <span role="status">正在读取…</span> : null}
      {historyFailed ? <span role="alert">{fault ?? '无法加载更早的记录。'}</span>
        : fault ? <span role="alert">{fault} <button type="button" onClick={() => void fetchPage('recent')}>重试</button></span> : null}
    </div>
    <div className={ledger.split} onKeyDown={e => {
      if (e.key === 'Escape' && selectedEvent) close();
      else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        moveTurn(e.key === 'ArrowUp' ? -1 : 1);
      }
    }}>
      <div className="ledger-column">
        {turnBarVisible ? <div className="turn-bar" role="group" aria-label="轮次导航">
          <button type="button" className="turn-step" onClick={() => moveTurn(-1)}
            disabled={currentTurnIndex <= 0} aria-label="上一轮" title="上一轮 (Alt+↑)">‹</button>
          <span className="turn-bar-label" title={currentGroup.turn ?? '日志未标记轮次'}>
            <strong>{turnLabel(currentGroup)}</strong>
            {clockTime(currentGroup.startedAt) ? <span className="turn-bar-time">{clockTime(currentGroup.startedAt)}</span> : null}
            <span className="turn-bar-count">{matches ? `${currentCount} / ${currentGroup.events.length}` : currentGroup.events.length} 条</span>
            {currentGroup.errorCount ? <span className="turn-bar-errors">{currentGroup.errorCount} 错误</span> : null}
          </span>
          <button type="button" className="turn-step" onClick={() => moveTurn(1)}
            disabled={currentTurnIndex >= visibleGroups.length - 1} aria-label="下一轮" title="下一轮 (Alt+↓)">›</button>
        </div> : null}
        <div ref={pane} className={`${ledger.tablePane} virtual-ledger`} onScroll={event => {
          const element = event.currentTarget;
          const top = element.scrollTop;
          const movingUp = top < previousTop.current;
          previousTop.current = top;
          const atBottom = !page.later && element.scrollHeight - element.clientHeight - top < 6;
          follow.current = atBottom;
          setFollowing(current => current === atBottom ? current : atBottom);
          if (atBottom) setNewRecords(current => current === 0 ? current : 0);
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
              {rows.slice(start, end).map(row => {
                if ('items' in row) {
                  const groupIndex = visibleGroups.findIndex(item => item.key === row.key);
                  return (
                    <tr key={row.key} className="turn-heading" data-collapsed-summary data-turn-key={row.key}>
                      <td colSpan={2}><div className="turn-heading-row">
                        <button type="button" className="turn-heading-collapse" aria-expanded={!row.folded}
                          title={row.group.turn ?? '日志未标记轮次'}
                          onClick={() => setCollapsed(current => {
                            const next = new Set(current);
                            if (next.has(row.key)) next.delete(row.key);
                            else next.add(row.key);
                            return next;
                          })}>
                          <span aria-hidden="true">{row.folded ? '▸' : '▾'}</span>
                          <span className="turn-heading-label">{turnLabel(row.group)}</span>
                          {clockTime(row.group.startedAt) ? <span className="turn-heading-time">{clockTime(row.group.startedAt)}</span> : null}
                          <span className="turn-count">{row.items.length} 条</span>
                          {row.group.errorCount ? <span className="turn-heading-errors">{row.group.errorCount} 错误</span> : null}
                        </button>
                        <span className="turn-heading-nav">
                          <button type="button" className="turn-heading-step" disabled={groupIndex <= 0}
                            onClick={() => moveToGroup(groupIndex - 1)} aria-label="上一轮" title="上一轮 (Alt+↑)">‹</button>
                          <button type="button" className="turn-heading-step" disabled={groupIndex >= visibleGroups.length - 1}
                            onClick={() => moveToGroup(groupIndex + 1)} aria-label="下一轮" title="下一轮 (Alt+↓)">›</button>
                        </span>
                      </div></td>
                    </tr>
                  );
                }
                if ('event' in row) return (
                  <tr key={row.key} tabIndex={0} data-kind={row.event.kind} data-selected={row.key === selected || undefined}
                    data-trajectory-record="" data-row-offset={row.key} data-timeline-focus={focused && !focused.has(row.key) ? 'outside' : undefined}
                    onClick={() => select(row.key)} onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(row.key); }
                    }}>
                    <td className={ledger.event}><div className={ledger.eventInner}><KindTag event={row.event} /></div></td>
                    <td className={ledger.content}><Content event={row.event} /></td>
                  </tr>
                );
                return (
                  <tr key={row.key} className="tool-cluster" data-tool-cluster="" data-row-offset={row.key}
                    tabIndex={0} aria-expanded={!row.folded} onClick={() => toggleTools(row.key, !row.folded)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleTools(row.key, !row.folded); }
                    }}>
                    <td className={ledger.event}><div className={ledger.eventInner}>
                      <span className={`${ledger.kindTag} ${ledger.toolAmber}`} aria-label={`工具组，${row.events.length} 个调用`}>
                        <span className={ledger.kindTagIcon} aria-hidden="true">{row.folded ? '▸' : '▾'}</span>
                        <span className={ledger.kindTagLabel} aria-hidden="true">工具 {row.events.length}</span>
                      </span>
                    </div></td>
                    <td className={ledger.content}><span className="tool-cluster-content">
                      <span className="tool-cluster-chevron" aria-hidden="true">{row.folded ? '▸' : '▾'}</span>
                      <span className="tool-cluster-summary">{toolRunSummary(row.events)}</span>
                      <span className="tool-cluster-peek">{toolCallSummary(row.events[0])}</span>
                    </span></td>
                  </tr>
                );
              })}
              {spacer(rows.length - end)}
              {rows.length === 0 ? <tr><td colSpan={2} className="history-note">
                {hasQuery ? '没有匹配的记录。' : '没有可显示的完整记录。'}
              </td></tr> : null}
            </tbody>
          </table>
        </div>
        {newRecords > 0 && !selectedEvent ? <button type="button" className="new-records" onClick={returnToLatest}>
          {newRecords} 条新记录 <span aria-hidden="true">↓</span>
        </button> : null}
      </div>
      {selectedEvent && active ? <Inspector key={selectedEvent.source.offset} id={id} event={selectedEvent} close={close} openAgent={openAgent} /> : null}
    </div>
  </>;
}
