export type EventKind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'result' | 'compaction' | 'error' | 'unknown';

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
  result?: { source: Source; preview: string; status: ToolState };
  problem?: string;
}

export type ToolState = 'returned' | 'error' | 'running';

export interface TrajectoryPage {
  events: TrajectoryEvent[];
  earlier: boolean;
  scanLimited: boolean;
  size: number;
}

export type DetailField = 'content' | 'raw';

export interface DetailPage {
  text: string;
  next: number | null;
}
