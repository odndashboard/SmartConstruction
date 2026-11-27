import 'server-only';
import { authenticate } from './auth';
import { todayIST } from './finance';
import { operationsRpc } from './operations-server';
import { CRMError } from './server-actions';
import type { OperationsData } from './operations-types';
import type { WorkspaceData } from './types';
import { runServerRead, OPTIONAL_OPERATIONS_TIMEOUT_MS, type ServerReadOptions } from './server-read';

export interface InitialWorkspace {
  workspace: WorkspaceData;
  operations: OperationsData | null;
  operationsError: string;
}

const OPERATIONS_UNAVAILABLE = 'Some dashboard summaries could not be loaded. Use Refresh overview to try again.';

/** One verified identity, two parallel live reads, and no cross-request cache. */
export async function getInitialWorkspace(options: ServerReadOptions & { jobId?: string | null } = {}): Promise<InitialWorkspace> {
  const jobId = options.jobId;
  if (jobId != null && !/^[A-Za-z0-9_-]{1,120}$/.test(jobId)) throw new CRMError('Choose a valid work order.');
  return runServerRead('dashboard', options, async read => {
    const identity = await read.stage('auth', signal => authenticate(signal));
    const workspaceRead = read.stage('workspace', signal => operationsRpc<WorkspaceData>('crm_workspace_read', {
      p_actor_id: identity.userId, p_full_audit: false,
    }, signal));
    const operationsRead = read.stage('operations', signal => operationsRpc<OperationsData>(jobId ? 'crm_job_materials_read' : 'crm_operations_v2_read', {
      p_actor_id: identity.userId, p_month: todayIST().slice(0, 7),
      ...(jobId ? { p_work_order_id: jobId } : {}),
    }, signal), OPTIONAL_OPERATIONS_TIMEOUT_MS);
    const [workspace, operationsResult] = await Promise.all([
      workspaceRead,
      operationsRead.then(operations => ({ operations, error: '' })).catch((error: unknown) => {
        // Losing access is not an optional module failure. Never serialize an
        // earlier privileged snapshot after another source reports a denial.
        if (error instanceof CRMError && [401, 403].includes(error.status)) throw error;
        return { operations: null, error: jobId ? 'Job stock history could not be loaded. Refresh the job to try again.' : OPERATIONS_UNAVAILABLE };
      }),
    ]);

    if (!workspace.user?.active || workspace.user.userId !== identity.userId) {
      throw new CRMError('Your workspace access changed. Please sign in again.', 403);
    }
    if (workspace.user.role === 'DEALER') throw new CRMError('Use the dealer lead portal.', 403);
    const operations = operationsResult.operations;
    if (operations && (!operations.user?.active || operations.user.userId !== identity.userId ||
      operations.user.role !== workspace.user.role || operations.permissions?.admin !== (workspace.user.role === 'OWNER'))) {
      throw new CRMError('Your workspace permissions changed. Please sign in again.', 403);
    }
    if (operations && !operations.extension) {
      return { workspace, operations: null, operationsError: OPERATIONS_UNAVAILABLE };
    }
    return { workspace, operations, operationsError: operationsResult.error };
  });
}
