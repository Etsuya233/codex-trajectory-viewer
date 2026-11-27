import type { TrajectoryCellProps } from './trajectory-record.ts';

export interface TrajectoryTurnModel {
  turn: number | null;
  groups: readonly { cells: readonly TrajectoryCellProps[] }[];
}
