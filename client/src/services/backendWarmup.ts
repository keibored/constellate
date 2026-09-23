const DEFAULT_DEADLINE_MS = 70_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 1_500;

export interface BackendWarmupOptions {
  fetcher?: typeof fetch;
  deadlineMs?: number;
  requestTimeoutMs?: number;
  retryMs?: number;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

/** Wake an idle production backend and wait until its dependencies report ready. */
export async function waitForBackend(options: BackendWarmupOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? sleep;
  const deadline = now() + deadlineMs;

  do {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetcher('/api/health', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.ok) {
        const health = await response.json() as { status?: unknown };
        if (health.status === 'ok') return true;
      }
    } catch {
      // A timed-out first request can still wake Render; the next probe observes readiness.
    } finally {
      clearTimeout(timeout);
    }
    if (now() < deadline) await delay(Math.min(retryMs, Math.max(0, deadline - now())));
  } while (now() < deadline);

  return false;
}

let warmup: Promise<boolean> | undefined;

/** Share one wake-up cycle across the page and room connection. */
export function prewarmBackend() {
  warmup ??= waitForBackend().finally(() => { warmup = undefined; });
  return warmup;
}
