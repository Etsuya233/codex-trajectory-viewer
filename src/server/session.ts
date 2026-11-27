import { createHash } from 'node:crypto';
import { readdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { DetailField, DetailPage, Source, ToolState, TrajectoryEvent, TrajectoryPage } from '../model.ts';

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CHUNK_BYTES = 64 * 1024;
const SCAN_BYTES = 8 * 1024 * 1024;
const PREVIEW_CHARS = 180;
const DETAIL_CHARS = 32 * 1024;
const PAGE_EVENTS = 50;

export class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function findSession(home: string, id: string): Promise<string> {
  if (!SESSION_ID.test(id)) throw new RequestError(400, '会话 ID 必须是 UUID。');
  const suffix = '-' + id.toLowerCase() + '.jsonl';
  async function find(directory: string): Promise<string | undefined> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.toLowerCase().endsWith(suffix)) {
        return join(directory, entry.name);
      }
    }
    const folders = entries.filter(entry => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
    for (const folder of folders) {
      const match = await find(join(directory, folder.name));
      if (match !== undefined) return match;
    }
  }
  const path = await find(join(home, 'sessions')) ?? await find(join(home, 'archived_sessions'));
  if (path === undefined) throw new RequestError(404, '找不到指定会话。');
  return path;
}

async function readBytes(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) throw new RequestError(409, '日志已变化，请重新打开会话。');
    filled += bytesRead;
  }
  return buffer;
}

/** Read completed lines backwards without opening any other log. */
async function* recentLines(file: FileHandle, size: number) {
  const minimum = Math.max(0, size - SCAN_BYTES);
  let end = size;
  let lineEnd = size;
  let fragments: Buffer[] = [];
  let terminated = false;
  while (end > minimum) {
    const start = Math.max(minimum, end - CHUNK_BYTES);
    const bytes = await readBytes(file, start, end - start);
    let previous = bytes.length;
    for (let index = bytes.lastIndexOf(10); index >= 0; index = index > 0 ? bytes.lastIndexOf(10, index - 1) : -1) {
      if (terminated && lineEnd > start + index + 1) {
        const startFragment = bytes.subarray(index + 1, previous);
        yield { offset: start + index + 1, bytes: fragments.length === 0
          ? startFragment : Buffer.concat([startFragment, ...fragments.reverse()]) };
      }
      terminated = true;
      fragments = [];
      lineEnd = start + index;
      previous = index;
    }
    if (terminated && previous > 0) fragments.push(bytes.subarray(0, previous));
    end = start;
  }
  if (minimum === 0 && terminated && lineEnd > 0) {
    yield { offset: 0, bytes: Buffer.concat(fragments.reverse()) };
  }
}

function parse(bytes: Buffer): RecordValue | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return typeof object(parsed).type === 'string' ? object(parsed) : null;
  } catch {
    return null;
  }
}

function sourceFor(offset: number, bytes: Buffer): Source {
  return { offset, length: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') };
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
}

function textBlocks(value: unknown, allowed: readonly string[]): string {
  return list(value).map(object)
    .filter(block => allowed.includes(string(block.type) ?? ''))
    .map(block => string(block.text) ?? '').filter(Boolean).join('\n\n');
}

function preview(value: string): string {
  const trimmed = value.slice(0, PREVIEW_CHARS + 1).replace(/\s+/g, ' ').trim();
  return value.length > PREVIEW_CHARS ? trimmed.slice(0, PREVIEW_CHARS) + '…' : trimmed;
}

function outputState(output: unknown, payload: RecordValue): ToolState {
  const metadata = object(output);
  const structured = typeof output === 'string' ? parseOutputObject(output) : metadata;
  const body = (typeof output === 'string' ? output : textBlocks(output, ['input_text'])).slice(0, 4096);
  const header = body.startsWith('Chunk ID:') ? body.split(/\r?\n(?:Original token count:|Final output:|Output:)/, 1)[0] : '';
  if (payload.is_error === true || structured.isError === true || structured.is_error === true
    || (typeof structured.exit_code === 'number' && structured.exit_code !== 0)
    || /^Process exited with code -?[1-9]\d*\b/m.test(header)) return 'error';
  if (typeof structured.session_id === 'number' || typeof structured.session_id === 'string'
    || /^Process running with session ID \S+/m.test(header)) return 'running';
  return 'returned';
}

function parseOutputObject(value: string): RecordValue {
  if (value.length > CHUNK_BYTES || !value.trimStart().startsWith('{')) return {};
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

const calls = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'image_generation_call', 'mcp_tool_call', 'tool_search_call']);
const results = new Set(['function_call_output', 'custom_tool_call_output', 'mcp_tool_call_output', 'tool_search_output']);
const housekeeping = new Set(['session_meta', 'turn_context', 'world_state', 'token_usage_record']);
const internalEvents = new Set([
  'task_started', 'task_complete', 'item_started', 'item_completed', 'token_count', 'thread_settings_applied',
  'user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content',
]);

function describe(record: RecordValue): { kind: TrajectoryEvent['kind']; label: string; content: string; callId?: string; state?: ToolState } | null {
  const type = string(record.type) ?? 'unknown';
  const payload = object(record.payload);
  const subtype = string(payload.type) ?? type;
  if (housekeeping.has(type)) return null;
  if (type === 'response_item') {
    const callId = string(payload.call_id);
    if (calls.has(subtype)) return {
      kind: 'tool', label: string(payload.name) ?? subtype,
      content: text(payload.arguments ?? payload.input ?? payload.action ?? payload.query), callId,
    };
    if (results.has(subtype)) {
      const output = payload.output ?? payload.result;
      return {
        kind: 'result', label: '工具结果', content: text(output), callId,
        state: outputState(output, payload),
      };
    }
    if (subtype === 'message') {
      const role = string(payload.role);
      if (role === 'user' || role === 'assistant') return {
        kind: role, label: role === 'user' ? '用户' : '助手',
        content: textBlocks(payload.content, ['input_text', 'output_text', 'text']),
      };
      return null;
    }
    if (subtype === 'reasoning') {
      const content = textBlocks(payload.summary, ['summary_text']);
      return content ? { kind: 'reasoning', label: '思考摘要', content } : null;
    }
    if (subtype === 'additional_tools') return null;
  }
  if (type === 'compacted' || subtype === 'context_compacted') return {
    kind: 'compaction', label: '上下文压缩', content: string(payload.message) ?? '',
  };
  if (type === 'event_msg') {
    if (internalEvents.has(subtype)) return null;
    if (subtype === 'error' || subtype === 'stream_error') return {
      kind: 'error', label: '错误', content: text(payload.message ?? payload.error),
    };
  }
  return { kind: 'unknown', label: subtype, content: '' };
}

export async function readRecent(path: string): Promise<TrajectoryPage> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const events: TrajectoryEvent[] = [];
    const pendingResults = new Map<string, TrajectoryEvent>();
    let group: TrajectoryEvent[] = [];
    let turn: string | null = null;
    let earliest = size;
    let stoppedAtBoundary = false;
    let omitted = false;

    for await (const line of recentLines(file, size)) {
      earliest = line.offset;
      const record = parse(line.bytes);
      const payload = object(record?.payload);
      const marker = record?.type === 'event_msg' ? payload.type : undefined;
      const turnId = string(payload.turn_id);
      if (marker === 'task_complete' && turnId) turn = turnId;
      if ((marker === 'task_started' || record?.type === 'turn_context') && turnId) {
        for (const event of group) event.turn = turnId;
        group = [];
        turn = marker === 'task_started' ? null : turnId;
        if (events.length >= PAGE_EVENTS && marker === 'task_started') {
          stoppedAtBoundary = true;
          break;
        }
      }
      if (events.length >= PAGE_EVENTS && omitted) continue;
      const description = record === null
        ? { kind: 'unknown' as const, label: '无法解析的记录', content: '' }
        : describe(record);
      if (description === null) continue;
      if (events.length >= PAGE_EVENTS) {
        omitted = true;
        continue;
      }
      const event: TrajectoryEvent = {
        source: sourceFor(line.offset, line.bytes),
        kind: description.kind,
        label: description.label,
        preview: preview(description.content),
        timestamp: string(record?.timestamp) ?? null,
        turn,
        callId: description.callId,
      };
      if (record === null) event.problem = '完整行无法按 Codex JSONL 解析。';
      if (description.kind === 'result') {
        if (description.callId && !pendingResults.has(description.callId)) pendingResults.set(description.callId, event);
        event.result = { source: event.source, preview: event.preview, status: description.state ?? 'returned' };
      }
      if (description.kind === 'tool' && description.callId) {
        const response = pendingResults.get(description.callId);
        if (response) {
          event.result = response.result;
          pendingResults.delete(description.callId);
          events.splice(events.indexOf(response), 1);
        }
      }
      events.push(event);
      group.push(event);
    }
    return { events: events.reverse(), earlier: omitted || earliest > 0, scanLimited: !stoppedAtBoundary && size > SCAN_BYTES, size };
  } finally {
    await file.close();
  }
}

export async function readDetail(path: string, source: Source, field: DetailField, from: number): Promise<DetailPage> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (source.offset + source.length >= size) throw new RequestError(409, '日志已变化，请重新打开会话。');
    const bytes = await readBytes(file, source.offset, source.length);
    if (sourceFor(source.offset, bytes).digest !== source.digest) {
      throw new RequestError(409, '记录已变化，请重新打开会话。');
    }
    const record = parse(bytes);
    const content = field === 'raw' ? bytes.toString('utf8').trimEnd() : record ? describe(record)?.content ?? '' : '';
    if (from > content.length) throw new RequestError(400, '详情位置超出范围。');
    let end = Math.min(content.length, from + DETAIL_CHARS);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    return { text: content.slice(from, end), next: end < content.length ? end : null };
  } finally {
    await file.close();
  }
}

export const detailSourceLimit = SCAN_BYTES;
