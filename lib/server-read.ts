import 'server-only';
import { CRMError } from './server-actions';

/** Leave time for the response to reach the browser's 15-second read deadline. */
export const SERVER_READ_TIMEOUT_MS = 10_000;
export const OPTIONAL_OPERATIONS_TIMEOUT_MS = 5_000;
type ReadStage = 'auth' | 'workspace' | 'operations' | 'team_activity';
type ReadOperation = 'dashboard' | 'workspace' | 'operations' | 'team_activity';

export interface ReadTiming { stages: Partial<Record<ReadStage, number>>; totalMs: number; }
export interface ServerReadOptions { signal?: AbortSignal; timing?: ReadTiming; }
export interface ServerReadScope {
  signal: AbortSignal;
  stage<T>(name: ReadStage, read: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T>;
}

export function createReadTiming(): ReadTiming { return { stages: {}, totalMs: 0 }; }

/** Header values contain fixed phase names and elapsed time only. */
export function serverTiming(timing: ReadTiming): string {
  return [...Object.entries(timing.stages).map(([name, duration]) => `${name};dur=${duration!.toFixed(1)}`),
    `total;dur=${timing.totalMs.toFixed(1)}`].join(', ');
}

function cancelledRead(): CRMError { return new CRMError('The refresh was cancelled. Please try again.', 503); }
function timedOutRead(): CRMError { return new CRMError('The workspace is taking too long to respond. Please try again.', 503); }

export function assertReadActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof CRMError ? signal.reason : cancelledRead();
}

/** Settle even when an SDK or a response body does not honour cancellation. */
async function readUntilCancelled<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  assertReadActive(signal);
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => { try { assertReadActive(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { assertReadActive(signal); return read(); }), cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** One deadline includes authentication and every downstream read; writes never use this helper. */
export async function runServerRead<T>(operation: ReadOperation, options: ServerReadOptions,
  read: (scope: ServerReadScope) => Promise<T>): Promise<T> {
  const started = performance.now(), controller = new AbortController();
  const timing = options.timing ?? createReadTiming();
  let interrupted = false;
  const interrupt = (reason: CRMError) => { interrupted = true; controller.abort(reason); };
  const onRequestAbort = () => interrupt(cancelledRead());
  if (options.signal?.aborted) onRequestAbort();
  else options.signal?.addEventListener('abort', onRequestAbort, { once: true });
  const timer = setTimeout(() => interrupt(timedOutRead()), SERVER_READ_TIMEOUT_MS);
  const scope: ServerReadScope = {
    signal: controller.signal,
    async stage(name, task, timeoutMs) {
      const phaseStart = performance.now(), phase = new AbortController();
      const signal = AbortSignal.any([controller.signal, phase.signal]);
      const deadline = timeoutMs === undefined ? undefined : setTimeout(() => phase.abort(timedOutRead()), timeoutMs);
      try { return await readUntilCancelled(signal, () => task(signal)); }
      finally {
        clearTimeout(deadline);
        timing.stages[name] = performance.now() - phaseStart;
        // Prevent any late transport callback from changing cookies or applying results.
        phase.abort(cancelledRead());
      }
    },
  };
  try { return await readUntilCancelled(controller.signal, () => read(scope)); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onRequestAbort);
    timing.totalMs = performance.now() - started;
    controller.abort(cancelledRead());
    if (interrupted) console.warn('CRM read interrupted', { operation, durationMs: Math.round(timing.totalMs) });
  }
}
