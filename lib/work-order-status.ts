import type { WorkStatus } from './types';

export const WORK_TRANSITIONS: Record<WorkStatus, readonly WorkStatus[]> = {
  PLANNED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['ACTIVE', 'CANCELLED'],
  COMPLETED: ['ACTIVE'],
  CANCELLED: [],
};

export const WORK_LABELS: Record<WorkStatus, string> = {
  PLANNED: 'Planned', ACTIVE: 'In progress', ON_HOLD: 'On hold', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};
