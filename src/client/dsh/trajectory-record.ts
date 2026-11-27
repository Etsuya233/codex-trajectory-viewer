import type { TrajectoryTranslate } from './locales.ts';

export type TrajectoryCellKind = 'system' | 'user' | 'context' | 'compacted' | 'message' | 'tool' | 'subtool';

export interface AssistantMetricDetail {
  timingRecorded?: boolean;
  stepStartTime?: number;
  firstTokenTime?: number;
  completedTime?: number;
}

export interface TrajectoryCellProps {
  index: number;
  kind: TrajectoryCellKind;
  text: string;
  requestOnly?: boolean;
  assistantMetrics?: AssistantMetricDetail;
  isError?: boolean;
  startedAt: number | null;
  timeSeconds: number | null;
}

export function formatDurationMillis(milliseconds: number, t: TrajectoryTranslate): string {
  return t('unit.milliseconds', { value: Math.round(milliseconds).toLocaleString('zh-CN') });
}
