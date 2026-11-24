import 'server-only';
import { authenticate } from './auth';
import { todayIST } from './finance';
import { operationsRpc } from './operations-server';
import { CRMError } from './server-actions';
import type { OperationsData } from './operations-types';
import type { WorkspaceData } from './types';

export interface InitialWorkspace {
  workspace: WorkspaceData;
  operations: OperationsData | null;
  operationsError: string;
}

const OPERATIONS_UNAVAILABLE = 'Some dashboard summaries could not be loaded. Use Refresh overview to try again.';

/** Abort reads at the deadline and still settle if the transport ignores abort. */
function bootstrapRead<T>(name: string, args: Record<string, unknown>, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: ((error: CRMError) => void) | undefined;
  let settled = false;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = reject;
    timer = setTimeout(() => {
      controller.abort();
      reject(new CRMError('The workspace is taking too long to respond. Please try again.', 503));
    }, timeoutMs);
  });
  const promise = Promise.race([operationsRpc<T>(name, args, controller.signal), stopped]).finally(() => {
    settled = true;
    clearTimeout(timer);
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      clearTimeout(timer);
      controller.abort();
      stop?.(new CRMError('The workspace read was cancelled.', 503));
    },
  };
}

/** One verified identity, two parallel live reads, and no cross-request cache. */
export async function getInitialWorkspace(): Promise<InitialWorkspace> {
  const identity = await authenticate();
  const workspaceRead = bootstrapRead<WorkspaceData>('crm_workspace_read', {
    p_actor_id: identity.userId, p_full_audit: false,
  }, 10_000);
  const operationsRead = bootstrapRead<OperationsData>('crm_operations_v2_read', {
    p_actor_id: identity.userId, p_month: todayIST().slice(0, 7),
  }, 5_000);

  try {
    const [workspace, operationsResult] = await Promise.all([
      workspaceRead.promise,
      operationsRead.promise.then(operations => ({ operations, error: '' })).catch((error: unknown) => {
        // Losing access is not an optional module failure. Never serialize an
        // earlier privileged snapshot after another source reports a denial.
        if (error instanceof CRMError && [401, 403].includes(error.status)) throw error;
        return { operations: null, error: OPERATIONS_UNAVAILABLE };
      }),
    ]);

    if (!workspace.user?.active || workspace.user.userId !== identity.userId) {
      throw new CRMError('Your workspace access changed. Please sign in again.', 403);
    }
    const operations = operationsResult.operations;
    if (operations && (!operations.user?.active || operations.user.userId !== identity.userId ||
      operations.user.role !== workspace.user.role || operations.permissions?.admin !== (workspace.user.role === 'OWNER'))) {
      throw new CRMError('Your workspace permissions changed. Please sign in again.', 403);
    }
    if (operations && !operations.extension) {
      return { workspace, operations: null, operationsError: OPERATIONS_UNAVAILABLE };
    }
    return { workspace, operations, operationsError: operationsResult.error };
  } finally {
    workspaceRead.cancel();
    operationsRead.cancel();
  }
}
