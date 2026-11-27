import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { IndexedPage, SearchPage, SessionStats, ToolResult, TrajectoryDelta, TrajectoryEvent } from '../model.ts';
import {
  agentLink, CHUNK_BYTES, completedCommand, describe, detailSourceLimit, eventFor, findSession, object, outputObject, parse, processId,
  readBytes, readRecent, RequestError, SESSION_ID, sourceFor, string,
} from './session.ts';
import type { RecordValue } from './session.ts';

const PAGE_SIZE = 50;
const MAX_SESSIONS = 8;
const SEARCH_RESULTS = 50;
const CHECKPOINT_BYTES = 256;
const perMetric = {
  totalTokens: 'total_tokens',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  cachedInputTokens: 'cached_input_tokens',
  reasoningOutputTokens: 'reasoning_output_tokens',
} as const;
type Metrics = Pick<SessionStats, keyof typeof perMetric>;
const emptyMetrics: Metrics = {
  totalTokens: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null,
};

function finiteNatural(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function payloadMetrics(payload: RecordValue): Metrics {
  return Object.fromEntries(Object.entries(perMetric).map(([key, field]) => [key, finiteNatural(payload[field])])) as Metrics;
}

function bound(offsets: number[], value: number, inclusive = false) {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] < value || (inclusive && offsets[mid] === value)) low = mid + 1;
    else high = mid;
  }
  return low;
}

function toolNamed(name: string, tool: string) {
  return name === tool || name.endsWith('.' + tool) || name.endsWith('__' + tool);
}

export class SessionIndex {
  readonly generation = randomUUID();
  readonly path: string;
  readonly id: string;
  private fingerprint: BigIntStats | null = null;
  private bytesRead = 0;
  private bytesVerified = 0;
  private checkpoint = Buffer.alloc(0);
  private cursor = 0;
  private lineStart = 0;
  private fragments: Buffer[] = [];
  private readonly ordered: number[] = [];
  private readonly events = new Map<number, TrajectoryEvent>();
  private readonly hidden = new Set<number>();
  private readonly changes: number[] = [];
  private readonly callOffsets = new Map<string, number>();
  private readonly resultOffsets = new Map<string, number>();
  private readonly endOffsets = new Map<string, number>();
  private readonly agentsByCall = new Map<string, NonNullable<TrajectoryEvent['agents']>>();
  private readonly processes = new Map<string, number>();
  private readonly continuations = new Map<string, string>();
  private readonly usage = new Set<string>();
  private readonly durations = new Map<string, number | null>();
  private readonly attributes = new Map<number, RecordValue>();
  private totals: Metrics = { ...emptyMetrics };
  private reported: Metrics | null = null;
  private turn: string | null = null;
  private fork: string | null = null;
  private inheritedBefore: number | null = null;

  constructor(path: string, id: string) {
    this.path = path;
    this.id = id;
  }

  get readByteCount() { return this.bytesRead; }
  get verificationByteCount() { return this.bytesVerified; }
  get revision() { return this.changes.length; }

  needsRebuild(snapshot: BigIntStats) {
    const previous = this.fingerprint;
    return previous !== null && (snapshot.dev !== previous.dev || snapshot.ino !== previous.ino
      || snapshot.birthtimeNs !== previous.birthtimeNs || snapshot.size < previous.size
      || (snapshot.size === previous.size && snapshot.mtimeNs !== previous.mtimeNs));
  }

  async update(snapshot: BigIntStats) {
    const size = Number(snapshot.size);
    if (size > this.cursor) {
      const file = await open(this.path, 'r');
      try {
        const opened = await file.stat({ bigint: true });
        if (opened.ino !== snapshot.ino || opened.dev !== snapshot.dev || opened.birthtimeNs !== snapshot.birthtimeNs
          || opened.size < snapshot.size || (opened.size === snapshot.size && opened.mtimeNs !== snapshot.mtimeNs)) {
          throw new RequestError(409, '日志正在替换，请重试。');
        }
        if (this.checkpoint.length) {
          const existing = await readBytes(file, this.cursor - this.checkpoint.length, this.checkpoint.length);
          this.bytesVerified += existing.length;
          if (!existing.equals(this.checkpoint)) throw new ReplacedLogError();
        }
        while (this.cursor < size) {
          const chunk = await readBytes(file, this.cursor, Math.min(CHUNK_BYTES, size - this.cursor));
          this.bytesRead += chunk.length;
          this.addChunk(chunk);
          this.checkpoint = chunk.length >= CHECKPOINT_BYTES ? Buffer.from(chunk.subarray(-CHECKPOINT_BYTES))
            : Buffer.concat([this.checkpoint, chunk]).subarray(-CHECKPOINT_BYTES);
          this.cursor += chunk.length;
        }
      } finally {
        await file.close();
      }
    }
    this.fingerprint = snapshot;
  }

  private addChunk(chunk: Buffer) {
    let start = 0;
    let end = chunk.indexOf(10);
    while (end >= 0) {
      const length = this.cursor + end - this.lineStart;
      if (length > 0 && length <= detailSourceLimit) {
        const segment = chunk.subarray(start, end);
        const bytes = this.fragments.length === 0 ? segment : Buffer.concat([...this.fragments, segment], length);
        this.accept(parse(bytes), this.lineStart, bytes);
      } else if (length > detailSourceLimit) {
        this.record({
          kind: 'unknown', label: '记录超过 64 MiB', preview: '', timestamp: null, turn: this.turn,
          source: { offset: this.lineStart, length, digest: '' },
          problem: '记录超过详情读取上限，原始日志仍保留此行。',
        });
      }
      this.fragments = [];
      start = end + 1;
      this.lineStart = this.cursor + start;
      end = chunk.indexOf(10, start);
    }
    if (start < chunk.length) {
      if (this.cursor + chunk.length - this.lineStart <= detailSourceLimit) this.fragments.push(chunk.subarray(start));
      else this.fragments = [];
    }
  }

  private record(event: TrajectoryEvent) {
    const offset = event.source.offset;
    this.ordered.push(offset);
    this.events.set(offset, event);
    this.changes.push(offset);
  }

  private accept(record: RecordValue | null, offset: number, bytes: Buffer) {
    const payload = object(record?.payload);
    const type = string(record?.type);
    const eventType = string(payload.type);
    const foreign = string(payload.thread_id);
    if (type === 'session_meta') {
      const reference = object(payload.history_base);
      this.fork = string(payload.forked_from_id) ?? string(reference.thread_id) ?? this.fork;
      this.inheritedBefore = finiteNatural(payload.subagent_history_start_ordinal)
        ?? (reference.thread_id ? null : finiteNatural(payload.forked_from_ordinal_exclusive));
    }
    const ordinal = finiteNatural(record?.ordinal);
    const inherited = payload.inherited === true || (foreign !== undefined && foreign.toLowerCase() !== this.id)
      || (ordinal !== null && this.inheritedBefore !== null && ordinal < this.inheritedBefore && type !== 'session_meta');
    if (eventType === 'task_started' || type === 'turn_context') this.turn = string(payload.turn_id) ?? this.turn;
    if (!inherited) this.recordStats(type, eventType, payload);
    const event = eventFor(record, offset, bytes, this.turn);
    if (event) {
      if (inherited) event.inherited = true;
      this.record(event);
      if (!inherited) this.associate(event, payload);
    }
    if (eventType === 'task_complete' || eventType === 'turn_aborted') this.turn = null;
  }

  private recordStats(type: string | undefined, eventType: string | undefined, payload: RecordValue) {
    if (type === 'token_usage_record') {
      const id = string(payload.response_id);
      if (!id || this.usage.has(id)) return;
      const values = payloadMetrics(object(payload.usage));
      if (Object.values(values).every(value => value === null)) return;
      for (const key of Object.keys(perMetric) as (keyof Metrics)[]) {
        const value = values[key];
        this.totals[key] = value === null || (this.usage.size > 0 && this.totals[key] === null)
          ? null : (this.totals[key] ?? 0) + value;
      }
      this.usage.add(id);
      this.changes.push(-1);
    }
    if (eventType === 'token_count' && this.fork === null) {
      const values = payloadMetrics(object(object(payload.info).total_token_usage));
      if (Object.values(values).some(value => value !== null)) {
        this.reported = values;
        this.changes.push(-1);
      }
    }
    if (eventType === 'task_complete') {
      const turn = string(payload.turn_id) ?? this.turn;
      if (turn) {
        const recorded = finiteNatural(payload.duration_ms);
        const existing = this.durations.get(turn);
        if (existing === undefined || existing === null) {
          this.durations.set(turn, recorded);
          this.changes.push(-1);
        }
      }
    }
  }

  private associate(event: TrajectoryEvent, payload: RecordValue) {
    const { callId, kind, source } = event;
    const command = completedCommand(payload);
    if (command) {
      const direct = callId ? this.callOffsets.get(callId) : undefined;
      const process = event.result?.processId;
      const processOffset = process ? this.processes.get(process) : undefined;
      if (this.linkEndTo(direct ?? processOffset, event) && process && event.result?.exitCode !== undefined) this.processes.delete(process);
      return;
    }
    if (!callId) return;
    if (kind === 'agent' && event.agents?.length) {
      this.agentsByCall.set(callId, event.agents);
      const call = this.callOffsets.get(callId);
      if (call !== undefined) this.linkAgents(callId, call);
      return;
    }
    if (payload.type === 'exec_command_end' && event.result?.exitCode !== undefined) {
      this.endOffsets.set(callId, source.offset);
      this.linkEnd(callId);
      return;
    }
    if (kind === 'tool') {
      this.callOffsets.set(callId, source.offset);
      this.linkEnd(callId);
      this.linkAgents(callId, source.offset);
      if (toolNamed(event.label, 'write_stdin')) {
        const args = outputObject(payload.arguments ?? payload.input);
        const process = processId(args.session_id);
        if (process) this.continuations.set(callId, process);
      }
    } else if (kind === 'result') {
      this.resultOffsets.set(callId, source.offset);
      const attrs = outputObject(payload.output ?? payload.result);
      if (attrs.agent_id || attrs.thread_id || attrs.new_thread_id) this.attributes.set(source.offset, {
        agent_id: attrs.agent_id, thread_id: attrs.thread_id, new_thread_id: attrs.new_thread_id, nickname: attrs.nickname,
      });
    } else {
      return;
    }
    const callOffset = this.callOffsets.get(callId);
    const resultOffset = this.resultOffsets.get(callId);
    if (callOffset === undefined || resultOffset === undefined) return;
    const call = this.events.get(callOffset)!;
    const result = this.events.get(resultOffset)?.result;
    if (!result) return;
    call.result = result;
    this.hidden.add(resultOffset);
    this.changes.push(callOffset, resultOffset);
    this.linkProcess(call, result, callId);
    if (toolNamed(call.label, 'spawn_agent') && !call.agents?.some(agent => agent.id)) {
      const attrs = this.attributes.get(resultOffset) ?? {};
      call.agents = [agentLink(attrs.agent_id ?? attrs.thread_id ?? attrs.new_thread_id, string(attrs.nickname))];
    }
    this.attributes.delete(resultOffset);
  }

  private linkEnd(callId: string) {
    const callOffset = this.callOffsets.get(callId);
    const resultOffset = this.endOffsets.get(callId);
    if (callOffset === undefined || resultOffset === undefined || this.hidden.has(resultOffset)) return;
    this.linkEndTo(callOffset, this.events.get(resultOffset)!);
  }

  private linkEndTo(callOffset: number | undefined, event: TrajectoryEvent) {
    const call = callOffset === undefined ? undefined : this.events.get(callOffset);
    const result = event.result;
    if (!call || !result || !toolNamed(call.label, 'exec_command')) return false;
    call.processUpdates = [...(call.processUpdates ?? []), result];
    this.hidden.add(event.source.offset);
    this.changes.push(call.source.offset, event.source.offset);
    return true;
  }

  private linkAgents(callId: string, offset: number) {
    const links = this.agentsByCall.get(callId);
    if (!links) return;
    this.events.get(offset)!.agents = links;
    this.changes.push(offset);
  }

  private linkProcess(call: TrajectoryEvent, result: ToolResult, callId: string) {
    if (toolNamed(call.label, 'exec_command') && result.processId && result.status === 'running'
      && !call.processUpdates?.some(update => update.exitCode !== undefined)) {
      this.processes.set(result.processId, call.source.offset);
    }
    const process = this.continuations.get(callId);
    if (!process) return;
    const originOffset = this.processes.get(process);
    const origin = originOffset === undefined ? undefined : this.events.get(originOffset);
    if (origin) {
      origin.processUpdates = [...(origin.processUpdates ?? []), result];
      this.changes.push(origin.source.offset);
      if (result.exitCode !== undefined) {
        this.processes.delete(process);
      }
    }
  }

  page(before?: number, around?: number, after?: number): IndexedPage {
    let start = 0;
    let end = this.ordered.length;
    const slice = (cursor: number, direction: -1 | 1, limit: number) => {
      const result: TrajectoryEvent[] = [];
      while (cursor >= 0 && cursor < this.ordered.length && result.length < limit) {
        const offset = this.ordered[cursor];
        if (!this.hidden.has(offset)) result.push(this.events.get(offset)!);
        cursor += direction;
      }
      return result;
    };
    let events: TrajectoryEvent[];
    if (around !== undefined) {
      const position = bound(this.ordered, around);
      events = [...slice(position - 1, -1, 24).reverse(), ...slice(position, 1, 26)];
    } else if (after !== undefined) {
      start = bound(this.ordered, after, true);
      events = slice(start, 1, PAGE_SIZE);
    } else {
      if (before !== undefined) end = bound(this.ordered, before);
      events = slice(end - 1, -1, PAGE_SIZE).reverse();
    }
    const first = events[0]?.source.offset;
    const last = events.at(-1)?.source.offset;
    return {
      events, earlier: first === undefined ? start > 0 : slice(bound(this.ordered, first) - 1, -1, 1).length > 0,
      later: last === undefined ? end < this.ordered.length : slice(bound(this.ordered, last, true), 1, 1).length > 0,
      size: this.cursor, scanLimited: false, indexing: false, generation: this.generation, revision: this.revision,
    };
  }

  delta(generation: string, revision: number, lower: number, upper: number | undefined): TrajectoryDelta {
    const reset = generation !== this.generation || revision > this.revision;
    if (reset) return { generation: this.generation, revision: this.revision, events: [], removed: [], more: false, reset };
    const next = Math.min(this.revision, revision + 500);
    const offsets = new Set(this.changes.slice(revision, next));
    const events: TrajectoryEvent[] = [];
    const removed: number[] = [];
    for (const offset of offsets) {
      if (offset < lower || (upper !== undefined && offset > upper)) continue;
      if (this.hidden.has(offset)) removed.push(offset);
      else events.push(this.events.get(offset)!);
    }
    return { generation, revision: next, events, removed, more: next < this.revision, reset };
  }

  statistics(): SessionStats {
    const source = this.usage.size > 0 ? 'response-usage' : this.reported ? 'reported-cumulative' : null;
    const durations = Array.from(this.durations.values()).filter(value => value !== null);
    return {
      ...(this.usage.size > 0 ? this.totals : this.reported ?? emptyMetrics),
      source, completedTurns: this.durations.size, recordedTimedTurns: durations.length,
      durationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
    };
  }

  async search(term: string, tool: string, errorsOnly: boolean, before: number | undefined, signal?: AbortSignal): Promise<SearchPage> {
    const matches: TrajectoryEvent[] = [];
    const needle = term.toLowerCase();
    const toolName = tool.toLowerCase();
    const file = needle ? await open(this.path, 'r') : null;
    try {
      const start = before === undefined ? this.ordered.length : bound(this.ordered, before);
      for (let index = start - 1; index >= 0; index--) {
        signal?.throwIfAborted();
        const offset = this.ordered[index];
        if (this.hidden.has(offset)) continue;
        const event = this.events.get(offset)!;
        if (toolName && (event.kind !== 'tool' || !event.label.toLowerCase().includes(toolName))) continue;
        if (errorsOnly && event.kind !== 'error' && event.result?.status !== 'error'
          && !event.processUpdates?.some(result => result.status === 'error')) continue;
        if (needle && !await this.matches(file!, event, needle)) continue;
        if (matches.length === SEARCH_RESULTS) return { events: matches, next: matches.at(-1)!.source.offset };
        matches.push(event);
      }
      return { events: matches, next: null };
    } finally {
      await file?.close();
    }
  }

  private async matches(file: FileHandle, event: TrajectoryEvent, needle: string) {
    if (`${event.label} ${event.preview} ${event.result?.preview ?? ''}`.toLowerCase().includes(needle)) return true;
    const sources = new Map([event.source, ...(event.result ? [event.result.source] : []),
      ...(event.processUpdates ?? []).map(result => result.source)].map(source => [source.offset, source]));
    for (const source of sources.values()) {
      if (!source.digest) continue;
      const bytes = await readBytes(file, source.offset, source.length);
      if (sourceFor(source.offset, bytes).digest !== source.digest) throw new RequestError(409, '日志已变化，请重新搜索。');
      const record = parse(bytes);
      const text = record ? describe(record)?.content || (event.kind === 'unknown' ? bytes.toString('utf8') : '') : bytes.toString('utf8');
      const output = string(completedCommand(object(record?.payload))?.aggregated_output) ?? '';
      if (text.toLowerCase().includes(needle) || output.toLowerCase().includes(needle)) return true;
    }
    return false;
  }
}

class ReplacedLogError extends Error {}

interface Entry {
  path: string;
  index: SessionIndex | null;
  updating?: Promise<SessionIndex>;
}

export class IndexStore {
  private readonly home: string;
  private readonly entries = new Map<string, Promise<Entry>>();

  constructor(home: string) { this.home = home; }

  private entry(id: string) {
    if (!SESSION_ID.test(id)) throw new RequestError(400, '会话 ID 必须是 UUID。');
    const key = id.toLowerCase();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = findSession(this.home, id).then(path => ({ path, index: null }));
      entry.catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > MAX_SESSIONS) this.entries.delete(this.entries.keys().next().value!);
    return entry;
  }

  async path(id: string) {
    const entry = await this.entry(id);
    await this.snapshot(id, entry);
    return entry.path;
  }

  async recent(id: string): Promise<IndexedPage> {
    const entry = await this.entry(id);
    if (entry.index === null) {
      // Give a large log a bounded tail preview while the forward scan runs separately.
      const preview = await readRecent(entry.path).catch(async cause => {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
        await this.snapshot(id, entry);
        return readRecent(entry.path);
      });
      void this.refresh(id, entry).catch(() => undefined);
      return { ...preview, generation: '', revision: 0, later: false, indexing: true };
    }
    return (await this.refresh(id, entry)).page();
  }

  async indexed(id: string) {
    return this.refresh(id, await this.entry(id));
  }

  private async snapshot(id: string, entry: Entry) {
    try {
      return await stat(entry.path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entry.path = await findSession(this.home, id);
      return stat(entry.path, { bigint: true });
    }
  }

  private refresh(id: string, entry: Entry): Promise<SessionIndex> {
    if (entry.updating) return entry.updating;
    entry.updating = (async () => {
      try {
        const snapshot = await this.snapshot(id, entry);
        const existing = entry.index;
        let current = existing === null || existing.path !== entry.path || existing.needsRebuild(snapshot)
          ? new SessionIndex(entry.path, id.toLowerCase()) : existing;
        try {
          await current.update(snapshot);
        } catch (error) {
          if (!(error instanceof ReplacedLogError)) throw error;
          current = new SessionIndex(entry.path, id.toLowerCase());
          await current.update(snapshot);
        }
        entry.index = current;
        return current;
      } catch (error) {
        entry.index = null;
        throw error;
      } finally {
        entry.updating = undefined;
      }
    })();
    return entry.updating;
  }
}
