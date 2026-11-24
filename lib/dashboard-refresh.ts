import type { WorkspaceData } from './types';
import type { OperationsData } from './operations-types';
import { readJson } from './client-read.ts';

export interface DashboardSnapshot {
  workspace: WorkspaceData;
  operations: OperationsData | null;
  operationsError: string;
}

export class DashboardRefreshError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DashboardRefreshError';
    this.status = status;
  }
}

type ExpectedMember = Pick<WorkspaceData['user'], 'userId' | 'role' | 'active'>;
const ACCESS_CHANGED = 'Your workspace access changed. Refresh or sign in again to continue.';
const INCOMPLETE_RESPONSE = 'The server returned an incomplete overview. Please refresh.';

/** One authenticated response supplies the workspace and its operations summary. */
export async function readDashboardSnapshot(expected: ExpectedMember, options: { signal?: AbortSignal } = {}): Promise<DashboardSnapshot> {
  const { response, body } = await readJson<Partial<DashboardSnapshot> & { error?: string }>('/api/dashboard', options);
  if (!response.ok) {
    const message = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
    throw new DashboardRefreshError(response.status === 401 ? 'Please sign in again to view your workspace.'
      : response.status === 403 ? ACCESS_CHANGED : message || 'Your workspace could not be refreshed. Please try again.', response.status);
  }

  if (!body || typeof body !== 'object') throw new DashboardRefreshError(INCOMPLETE_RESPONSE, 503);
  const workspace = body.workspace;
  if (!workspace?.user || !Number.isSafeInteger(workspace.revision) || workspace.revision < 0) {
    throw new DashboardRefreshError(INCOMPLETE_RESPONSE, 503);
  }
  if (!expected.active || !workspace.user.active || workspace.user.userId !== expected.userId || workspace.user.role !== expected.role) {
    throw new DashboardRefreshError(ACCESS_CHANGED, 403);
  }
  const operations = body.operations;
  if (operations !== null && (!operations || typeof operations !== 'object')) throw new DashboardRefreshError(INCOMPLETE_RESPONSE, 503);
  if (operations && (!operations.user?.active || operations.user.userId !== workspace.user.userId ||
    operations.user.role !== workspace.user.role || operations.permissions?.admin !== (workspace.user.role === 'OWNER'))) {
    throw new DashboardRefreshError(ACCESS_CHANGED, 403);
  }
  if (operations && !operations.extension) throw new DashboardRefreshError(INCOMPLETE_RESPONSE, 503);
  return { workspace, operations, operationsError: typeof body.operationsError === 'string' ? body.operationsError
    : operations ? '' : 'Some dashboard summaries could not be loaded. Use Refresh overview to try again.' };
}

/** Never resurrect cleared access or replace a newer edit with a late refresh. */
export function mergeDashboardWorkspace(current: WorkspaceData | null, next: WorkspaceData): WorkspaceData | null {
  if (!current?.user.active || !next.user.active || current.user.userId !== next.user.userId) return null;
  if (current.revision > next.revision) return current;
  if (current.user.role !== next.user.role) return null;
  return next;
}

/** A delayed write response may confirm a save, but cannot restore old access. */
export function mergeWorkspaceUpdate(current: WorkspaceData | null, next: WorkspaceData): WorkspaceData | null {
  if (!current?.user.active) return null;
  if (!next.user.active || current.user.userId !== next.user.userId || current.user.role !== next.user.role || current.revision > next.revision) return current;
  return next;
}
