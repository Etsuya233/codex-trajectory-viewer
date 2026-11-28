import { useEffect, useState, type ReactNode } from 'react';
import type { AgentLink, DetailField, DetailPage, EventKind, SessionMeta, Source, TrajectoryEvent } from '../model.ts';
import type { TrajectoryCellKind } from './dsh/trajectory-record.ts';
import ledger from './dsh/TrajectoryTable.module.css';
import { errorMessage, request, sessionUrl } from './api.ts';
import { formatDuration } from './format.ts';
import { agentLabel } from './SessionTools.tsx';

export const kindStyles: Record<EventKind, { name: string; glyph: string; style: string; lane: TrajectoryCellKind }> = {
  user: { name: '用户', glyph: '人', style: ledger.user, lane: 'user' },
  assistant: { name: '助手', glyph: '✦', style: ledger.message, lane: 'message' },
  reasoning: { name: '摘要', glyph: '·', style: ledger.message, lane: 'message' },
  tool: { name: '工具', glyph: '↗', style: ledger.toolAmber, lane: 'tool' },
  result: { name: '结果', glyph: '↳', style: ledger.toolAmber, lane: 'tool' },
  compaction: { name: '压缩', glyph: '⇥', style: ledger.compacted, lane: 'compacted' },
  inheritance: { name: '继承', glyph: '⇤', style: ledger.compacted, lane: 'context' },
  agent: { name: '子代理', glyph: '↗', style: ledger.toolAmber, lane: 'subtool' },
  unknown: { name: '事件', glyph: '…', style: ledger.systemNeutral, lane: 'system' },
  error: { name: '错误', glyph: '!', style: ledger.systemNeutral, lane: 'system' },
};

export function hasError(event: TrajectoryEvent) {
  return event.kind === 'error' || event.result?.status === 'error' ||
    (event.processUpdates?.some(result => result.exitCode !== undefined && result.exitCode !== 0) ?? false);
}

export function timeValue(timestamp: string | null) {
  const milliseconds = timestamp === null ? NaN : Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function KindTag({ event }: { event: TrajectoryEvent }) {
  const { name, glyph, style } = kindStyles[event.kind];
  return (
    <span className={`${ledger.kindTag} ${style} ${hasError(event) ? ledger.error : ''}`} aria-label={name}>
      <span className={ledger.kindTagIcon} aria-hidden="true">{glyph}</span>
      <span className={ledger.kindTagLabel} aria-hidden="true">{name}</span>
    </span>
  );
}

function Status({ event }: { event: TrajectoryEvent }) {
  const exit = event.processUpdates?.findLast(result => result.exitCode !== undefined)?.exitCode;
  const state = exit === undefined ? event.result?.status : exit === 0 ? 'returned' : 'error';
  if (event.kind !== 'tool' && state === undefined) return null;
  const labels = { returned: '已返回', error: '错误', running: '后台运行中' };
  return <span className={state === 'error' ? ledger.error : undefined}>
    {exit === undefined ? state ? labels[state] : '未见结果' : `进程已退出（${exit}）`}
  </span>;
}

function firstLine(value: string) {
  const line = value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > 160 ? line.slice(0, 160) + '…' : line;
}

export function toolCallSummary(event: TrajectoryEvent) {
  return firstLine(event.preview);
}

export function toolResultSummary(event: TrajectoryEvent) {
  if (!event.result) return '未见结果';
  const exit = event.processUpdates?.findLast(update => update.exitCode !== undefined)?.exitCode ?? event.result.exitCode;
  if (event.result.status === 'running' && exit === undefined) return '运行中';
  const update = event.processUpdates?.findLast(result => result.preview !== '');
  return firstLine(update?.preview || event.result.preview) || (event.result.outputMissing ? '未记录输出' : '空结果');
}

export function toolRunSummary(events: TrajectoryEvent[]) {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.label, (counts.get(event.label) ?? 0) + 1);
  const names = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([name, count]) => `${name} ×${count}`)
    .join(', ');
  const errors = events.filter(hasError).length;
  return `${events.length} 个工具调用${errors ? ` · ${errors} 失败` : ''}${names ? ' · ' + names : ''}`;
}

export function Content({ event }: { event: TrajectoryEvent }) {
  if (event.kind === 'tool') {
    const duration = formatDuration(event.durationMs);
    const exit = event.processUpdates?.findLast(update => update.exitCode !== undefined)?.exitCode ?? event.result?.exitCode;
    const state = event.result?.status;
    const status = exit !== undefined && exit !== 0 ? `exit ${exit}`
      : state === 'error' ? '错误' : null;
    return (
      <span className={`${ledger.resultPreview} tool-line`}>
        <span className={`${ledger.resultRequest} tool-request`}>
          <strong className={ledger.toolCallNameTypeface}>{event.label}</strong>
          <span className={`${ledger.toolCallPayload} tool-args`}>{toolCallSummary(event)}</span>
          {duration ? <span className="tool-duration" title="工具执行耗时">{duration}</span> : null}
        </span>
        {event.result
          ? <span className={`${ledger.inlineResult} ${hasError(event) ? ledger.error : ''}`}>
              {status ? <span className="tool-exit" data-error={hasError(event) || undefined}>{status}</span> : null}
              <span className={ledger.arrow}>→</span>
              <span className={ledger.inlineResultText}>{toolResultSummary(event)}</span>
            </span>
          : null}
      </span>
    );
  }
  return <span className={ledger.contentText}>{event.preview || event.problem || event.label}</span>;
}

function AgentOpenButton({ agent, openAgent }: { agent: AgentLink; openAgent: (id: string) => void }) {
  const [name, setName] = useState<string | null>(agent.name ?? null);
  const [kind, setKind] = useState<SessionMeta['kind']>('subagent');
  useEffect(() => {
    if (!agent.id) return;
    const abort = new AbortController();
    request<SessionMeta>(sessionUrl(agent.id) + '/meta', abort.signal).then(meta => {
      if (abort.signal.aborted) return;
      setName(current => current ?? meta.name);
      setKind(meta.kind);
    }).catch(() => undefined);
    return () => abort.abort();
  }, [agent.id]);
  const display = name ? (agent.path ? `${name} · ${agent.path}` : name) : agentLabel(agent);
  const label = `${kind === 'thread' ? '打开会话' : '打开子代理'} ${display}`;
  return <button type="button" title={label} onClick={() => openAgent(agent.id!)}>{label}</button>;
}

interface PayloadSource {
  source: Source;
  field: DetailField;
}

interface InspectorTab extends PayloadSource {
  label: string;
}

export function Inspector({ id, event, close, openAgent }: { id: string; event: TrajectoryEvent; close: () => void; openAgent: (id: string) => void }) {
  const tabs: InspectorTab[] = [];
  if (event.kind === 'tool') {
    tabs.push({ label: '详情', source: event.source, field: 'input' }, { label: '原始', source: event.source, field: 'raw' });
  } else {
    if (event.kind !== 'unknown') tabs.push({
      label: event.kind === 'result' ? '结果' : event.kind === 'reasoning' ? '思考摘要' : '内容',
      source: event.source,
      field: 'content',
    });
    tabs.push({ label: '原始记录', source: event.source, field: 'raw' });
  }
  const [active, setActive] = useState(tabs[0].label);
  const [viewedRaw, setViewedRaw] = useState(false);
  const tab = tabs.find(entry => entry.label === active) ?? tabs[0];
  const timestamp = timeValue(event.timestamp);
  const duration = formatDuration(event.durationMs);

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
        {duration ? <span>{duration}</span> : null}
        {event.inherited ? <span>继承记录</span> : null}
        <span title="会话日志字节偏移">字节 {tab.source.offset.toLocaleString('zh-CN')}</span>
      </div>
      <div className={ledger.detailTabs} aria-label="详情视图">
        {tabs.map(entry => (
          <button type="button" key={entry.label} className={`${ledger.detailTab} ${entry === tab ? ledger.detailTabActive : ''}`}
            aria-pressed={entry === tab} onClick={() => {
              setActive(entry.label);
              if (entry.field === 'raw') setViewedRaw(true);
            }}>{entry.label}</button>
        ))}
      </div>
      {event.agents?.length ? <div className="record-meta">{event.agents.map((agent, index) =>
        agent.id ? <AgentOpenButton key={agent.id} agent={agent} openAgent={openAgent} />
          : <span key={index}>{agentLabel(agent)} · 无可用会话 ID</span>)}</div> : null}
      {event.kind === 'tool' ? <>
        <ToolDetails id={id} event={event} hidden={tab.field === 'raw'} />
        {viewedRaw ? <ToolDetails id={id} event={event} raw hidden={tab.field !== 'raw'} /> : null}
      </> : tab.source.digest ? <Payload key={`${tab.source.offset}:${tab.field}`} id={id} source={tab.source} field={tab.field} />
        : <p className="payload">{event.problem}</p>}
    </aside>
  );
}

function DetailSection({ label, initiallyOpen = false, children }: { label: string; initiallyOpen?: boolean; children: ReactNode }) {
  const [state, setState] = useState({ open: initiallyOpen, loaded: initiallyOpen });
  return <details className="detail-section" open={state.open} onToggle={event => {
    const open = event.currentTarget.open;
    setState(previous => previous.open === open ? previous : { open, loaded: previous.loaded || open });
  }}>
    <summary>{label}</summary>
    {state.loaded ? children : null}
  </details>;
}

function ToolDetails({ id, event, raw = false, hidden }: { id: string; event: TrajectoryEvent; raw?: boolean; hidden: boolean }) {
  const outputs = [...(event.result ? [event.result] : []), ...(event.processUpdates ?? [])];
  const outputRecords = new Map(outputs.map(result => [result.source.offset, result.source]));
  outputRecords.delete(event.source.offset);
  const pending = event.result?.status === 'running' && !event.processUpdates?.some(result => result.exitCode !== undefined);
  return <div className="tool-details" hidden={hidden}>
    <DetailSection label={raw ? '原始输入' : '输入'} initiallyOpen>
      <Payload id={id} source={event.source} field={raw ? 'raw-input' : 'input'} copyable compact={!raw}
        emptyText="日志未记录输入。" />
    </DetailSection>
    <DetailSection label={raw ? '原始输出' : '输出'} initiallyOpen={!raw}>
      {outputs.length === 0 ? <p className="detail-empty">日志未记录结果。</p> : outputs.map((result, index) => (
        <div className={outputs.length > 1 ? 'detail-output detail-output-caption' : 'detail-output'} key={`${result.source.offset}:${index}`}>
          {outputs.length > 1 ? <p className="detail-source">{index === 0 && event.result ? '初始输出' : `后续输出 ${event.result ? index : index + 1}`}</p> : null}
          {result.outputMissing ? <p className="detail-empty">{pending ? '运行中，尚无输出。' : '日志未记录输出。'}</p>
            : <Payload id={id} source={result.source} field={raw ? 'raw-output' : 'output'} copyable
              emptyText={pending ? '运行中，尚无输出。' : result.status === 'error' ? '执行失败，无文本输出。' : '已返回，无文本输出。'} />}
        </div>
      ))}
    </DetailSection>
    {raw ? <DetailSection label="JSONL 记录">
      <div className="detail-output detail-output-caption">
        <p className="detail-source">{event.result?.source.offset === event.source.offset ? '调用与结果' : '调用记录'}</p>
        <Payload id={id} source={event.source} field="raw" copyable />
      </div>
      {[...outputRecords.values()].map(source => <div className="detail-output detail-output-caption" key={source.offset}>
        <p className="detail-source">结果记录 · 字节 {source.offset.toLocaleString('zh-CN')}</p>
        <Payload id={id} source={source} field="raw" copyable />
      </div>)}
    </DetailSection> : null}
  </div>;
}

async function copyText(value: string) {
  try { await navigator.clipboard.writeText(value); return; } catch {
    const field = document.createElement('textarea');
    const focused = document.activeElement;
    field.value = value;
    field.className = 'payload-copy-buffer';
    document.body.append(field);
    field.select();
    try {
      if (!document.execCommand('copy')) throw new Error('无法复制');
    } finally {
      field.remove();
      if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    }
  }
}

function Payload({ id, source, field, copyable = false, compact = false, emptyText = '此记录没有可显示的内容。' }:
  PayloadSource & { id: string; copyable?: boolean; compact?: boolean; emptyText?: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [page, setPage] = useState<DetailPage>({ text: '', next: 0 });
  const [from, setFrom] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null);
  const { offset, length, digest } = source;

  useEffect(() => {
    const abort = new AbortController();
    const query = new URLSearchParams({ offset: String(offset), length: String(length), digest, field, from: String(from) });
    request<DetailPage>(`${sessionUrl(id)}/detail?${query}`, abort.signal)
      .then(next => {
        if (abort.signal.aborted) return;
        setPage(current => ({ text: from === 0 ? next.text : current.text + next.text, next: next.next }));
        setStatus('ready');
      })
      .catch(cause => {
        if (abort.signal.aborted) return;
        setError(errorMessage(cause));
        setStatus('error');
      });
    return () => abort.abort();
  }, [id, offset, length, digest, field, from, attempt]);

  const longInput = compact && (page.text.length > 720 || page.text.split('\n', 9).length > 8);
  const copyLabel = page.next === null ? '复制' : '复制已加载内容';
  const copyFeedback = copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '';

  return (
    <div className="payload">
      {page.text !== '' ? <>
        {copyable ? <div className="payload-copy">
          <span className={ledger.visuallyHidden} role="status">{copyFeedback}</span>
          <button type="button" title={copyLabel} onClick={() => {
            void copyText(page.text).then(() => setCopyState('copied'), () => setCopyState('failed'));
          }}>{copyFeedback || copyLabel}</button>
        </div> : null}
        <pre data-testid="payload-text" className={longInput && !expanded ? 'payload-limited' : undefined}>{page.text}</pre>
      </> : null}
      {status === 'ready' && !page.text ? <p>{emptyText}</p> : null}
      {longInput || (status === 'ready' && page.next !== null) ? <div className="payload-actions">
        {longInput ? <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}</button> : null}
        {status === 'ready' && page.next !== null ? <button type="button" onClick={() => {
          setStatus('loading'); setFrom(page.next!); setExpanded(true); setCopyState(null);
        }}>加载更多内容</button> : null}
      </div> : null}
      {status === 'loading' ? <p role="status">正在读取详情…</p> : null}
      {status === 'error' ? <p role="alert">{error} <button type="button" onClick={() => {
        setStatus('loading');
        setAttempt(current => current + 1);
      }}>重试</button></p> : null}
    </div>
  );
}
