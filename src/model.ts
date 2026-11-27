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
}

export interface ToolResult {
  source: Source;
  preview: string;
  status: ToolState;
  processId?: string;
  exitCode?: number;
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
  date: string;
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

export type DetailField = 'content' | 'result' | 'raw';

export interface DetailPage {
  text: string;
  next: number | null;
}
