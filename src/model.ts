export type EventKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'result' | 'compaction' | 'inheritance' | 'agent' | 'error' | 'unknown';

export interface Source {
  offset: number;
  length: number;
  digest: string;
}

export interface TrajectoryEvent {
  source: Source;
  kind: EventKind;
  label: string;
  preview: string;
  timestamp: string | null;
  turn: string | null;
  /** Stable 1-based turn number assigned while indexing from the log start. */
  turnOrdinal?: number;
  callId?: string;
  result?: ToolResult;
  processUpdates?: ToolResult[];
  agents?: AgentLink[];
  inherited?: boolean;
  durationMs?: number;
  problem?: string;
}

export interface AgentLink {
  id: string | null;
  label: string;
  /** Human nickname recorded by the spawned agent, such as "Raman". */
  name?: string | null;
  /** Agent path recorded by the parent, such as "/root/m1_sol". */
  path?: string | null;
  role?: string | null;
}

export interface ToolResult {
  source: Source;
  preview: string;
  status: ToolState;
  processId?: string;
  exitCode?: number;
  outputMissing?: true;
  detailField?: 'result';
}

export type ToolState = 'returned' | 'error' | 'running';

export interface TrajectoryPage {
  events: TrajectoryEvent[];
  earlier: boolean;
  scanLimited: boolean;
  size: number;
}

export interface IndexedPage extends TrajectoryPage {
  generation: string;
  revision: number;
  later: boolean;
  indexing: boolean;
}

export interface TrajectoryDelta {
  generation: string;
  revision: number;
  events: TrajectoryEvent[];
  removed: number[];
  more: boolean;
  reset: boolean;
}

export interface SessionChoice {
  id: string;
  name: string | null;
  date: string;
  updatedAt: string | null;
  archived: boolean;
}

export interface SessionMeta {
  id: string;
  name: string | null;
  kind: 'thread' | 'subagent';
  parentId: string | null;
  agentPath: string | null;
  agentRole: string | null;
  date: string | null;
  archived: boolean;
}

export interface SessionStats {
  source: 'response-usage' | 'reported-cumulative' | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
  completedTurns: number;
  recordedTimedTurns: number;
  durationMs: number | null;
}

export interface SearchPage {
  events: TrajectoryEvent[];
  next: number | null;
}

export const detailFields = ['content', 'result', 'raw', 'input', 'output', 'raw-input', 'raw-output'] as const;
export type DetailField = typeof detailFields[number];

export function isDetailField(value: unknown): value is DetailField {
  return detailFields.some(field => field === value);
}

export interface DetailPage {
  text: string;
  next: number | null;
}
