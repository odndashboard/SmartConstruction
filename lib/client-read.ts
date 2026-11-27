import { PAYMENT_ACCOUNT_HEADERS } from './payment-response.ts';

/** A read must finish both its request and JSON body before its deadline. */
export const CLIENT_READ_TIMEOUT_MS = 15_000;

export class ReadTimeoutError extends Error {
  constructor() {
    super('Refreshing took too long. Check your connection and try again.');
    this.name = 'ReadTimeoutError';
  }
}

type ReadOptions = { signal?: AbortSignal; timeoutMs?: number };

/** GET only: never retry or interrupt a write whose result may be uncertain. */
export async function readJson<T>(url: string, { signal, timeoutMs = CLIENT_READ_TIMEOUT_MS }: ReadOptions = {}): Promise<{ response: Response; body: T }> {
  if (signal?.aborted) throw signal.reason || new DOMException('The read was cancelled.', 'AbortError');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason = signal?.reason || new DOMException('The read was cancelled.', 'AbortError');
      controller.abort(reason);
      reject(reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new ReadTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const read = async () => {
    const response = await fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: PAYMENT_ACCOUNT_HEADERS, signal: controller.signal });
    // Access has already failed. Let callers discard private data immediately,
    // even if an intermediary returned an HTML or stalled error body.
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      return { response, body: {} as T };
    }
    const body = await response.json() as T;
    return { response, body };
  };
  try {
    return await Promise.race([read(), stopped]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
