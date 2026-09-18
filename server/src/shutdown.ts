import { log } from './logger.js';

/** Idempotent drain with a hard deadline shorter than the hosting termination grace. */
export function createShutdown(steps: {
  beginDrain(): void;
  closeConnections(): Promise<void>;
  closeRuntime(): Promise<void>;
  closeRedis(): void;
  closeDatabase(): Promise<void>;
}, timeoutMs: number, exit: (code: number) => void = code => process.exit(code)) {
  let stopping: Promise<void> | undefined;
  return (signal: string) => {
    if (stopping) return stopping;
    steps.beginDrain();
    log('info', 'server.shutdown_started', 'Server is draining.', { signal });
    const deadline = setTimeout(() => {
      log('error', 'server.shutdown_timeout', 'Shutdown deadline exceeded; uncommitted accounting remains in Redis.');
      exit(1);
    }, timeoutMs);
    stopping = (async () => {
      let failed = false;
      for (const close of [steps.closeConnections, steps.closeRuntime, steps.closeRedis, steps.closeDatabase]) {
        try { await close(); }
        catch { failed = true; log('error', 'server.shutdown_failed', 'A shutdown step failed; continuing cleanup.'); }
      }
      clearTimeout(deadline);
      if (failed) process.exitCode = 1;
      log(failed ? 'error' : 'info', 'server.shutdown_complete', 'Server shutdown complete.');
    })();
    return stopping;
  };
}
