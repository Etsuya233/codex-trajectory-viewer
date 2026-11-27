import { useEffect, useState } from 'react';
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

function decodeJsonString(value: string) {
  try {
    return JSON.parse('"' + value + '"') as string;
  } catch {
    return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function jsonString(text: string, field: string) {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return match ? decodeJsonString(match[1]) : null;
}

function firstLine(value: string) {
  const line = value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > 160 ? line.slice(0, 160) + '…' : line;
}

/** A short, tool-aware label for the request side of a tool row. */
export function toolCallSummary(event: TrajectoryEvent) {
  const preview = event.preview;
  if (event.label === 'js' || event.label === 'exec') {
    const title = jsonString(preview, 'title');
    if (title) return title;
    const code = jsonString(preview, 'code');
    if (code) return firstLine(code);
    if (event.label === 'js' && preview.startsWith('{')) {
      const stripped = preview.replace(/^\{\s*"code"\s*:\s*"/, '').replace(/",\s*"title".*$/s, '');
      if (stripped !== preview) return firstLine(decodeJsonString(stripped));
    }
  }
  if (event.label === 'exec_command') {
    const command = jsonString(preview, 'cmd');
    if (command) return `$ ${firstLine(command)}`;
    const marker = '"-Command", "';
    const at = preview.indexOf(marker);
    if (at >= 0) return `$ ${firstLine(preview.slice(at + marker.length).replace(/\\n/g, ' '))}`;
  }
  if (event.label === 'send_message') {
    const target = jsonString(preview, 'target');
    const message = jsonString(preview, 'message');
    if (target) return `${target}${message ? ' · ' + firstLine(message) : ''}`;
  }
  return firstLine(preview);
}

/** Extract readable text or an image marker from a serialized tool result. */
export function toolResultSummary(event: TrajectoryEvent) {
  if (!event.result) return '未见结果';
  const exit = event.result.exitCode ?? event.processUpdates?.findLast(update => update.exitCode !== undefined)?.exitCode;
  if (event.result.status === 'running' && exit === undefined) return '运行中';
  if (/input_image|data:image\//.test(event.result.preview)) return '图片结果';
  const match = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(event.result.preview);
  const text = match ? decodeJsonString(match[1]) : event.result.preview;
  const output = text.indexOf('Output:');
  const useful = output >= 0 ? text.slice(output + 'Output:'.length) : text;
  return firstLine(useful) || '空结果';
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
    const exit = event.result?.exitCode ?? event.processUpdates?.findLast(update => update.exitCode !== undefined)?.exitCode;
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

interface InspectorTab {
  label: string;
  source: Source;
  field: DetailField;
}

export function Inspector({ id, event, close, openAgent }: { id: string; event: TrajectoryEvent; close: () => void; openAgent: (id: string) => void }) {
  const tabs: InspectorTab[] = [];
  if (event.kind !== 'unknown') tabs.push({
    label: event.kind === 'tool' ? '参数' : event.kind === 'result' ? '结果' : event.kind === 'reasoning' ? '思考摘要' : '内容',
    source: event.source,
    field: 'content',
  });
  if (event.kind === 'tool' && event.result) tabs.push({ label: '结果', source: event.result.source, field: event.result.detailField ?? 'content' });
  for (const [index, update] of (event.processUpdates ?? []).entries()) {
    tabs.push({ label: `后台输出 ${index + 1}`, source: update.source, field: update.detailField ?? 'content' });
  }
  tabs.push({ label: '原始记录', source: event.source, field: 'raw' });
  if (event.kind === 'tool' && event.result) tabs.push({ label: '原始结果', source: event.result.source, field: 'raw' });
  const [active, setActive] = useState(tabs[0].label);
  const tab = tabs.find(entry => entry.label === active) ?? tabs[0];
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
        {event.inherited ? <span>继承记录</span> : null}
        <span title="会话日志字节偏移">字节 {tab.source.offset.toLocaleString('zh-CN')}</span>
      </div>
      <div className={ledger.detailTabs} aria-label="详情视图">
        {tabs.map(entry => (
          <button type="button" key={entry.label} className={`${ledger.detailTab} ${entry === tab ? ledger.detailTabActive : ''}`}
            aria-pressed={entry === tab} onClick={() => setActive(entry.label)}>{entry.label}</button>
        ))}
      </div>
      {event.agents?.length ? <div className="record-meta">{event.agents.map((agent, index) =>
        agent.id ? <AgentOpenButton key={agent.id} agent={agent} openAgent={openAgent} />
          : <span key={index}>{agentLabel(agent)} · 无可用会话 ID</span>)}</div> : null}
      {tab.source.digest ? <Payload key={`${tab.source.offset}:${tab.field}`} id={id} tab={tab} />
        : <p className="payload">{event.problem}</p>}
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
