import { Redis } from 'ioredis';
import { log } from '../logger.js';

export class RuntimeUnavailableError extends Error {
  constructor(cause?: unknown) { super('The realtime state service is unavailable. Reconnecting…', { cause }); }
}
export function redisKeys(prefix: string) {
  if (!/^[A-Za-z0-9:_-]{1,100}$/.test(prefix)) throw new Error('REDIS_KEY_PREFIX must contain 1–100 letters, numbers, colons, underscores or hyphens.');
  return {
    room: (roomId: string) => `${prefix}:room:${roomId}:runtime`,
    due: `${prefix}:runtime:due`,
    access: (token: string) => `${prefix}:access:${token}`,
    adapter: `${prefix}:socket.io`,
  };
}
export class RedisConnections {
  readonly command: Redis;
  readonly publisher: Redis;
  readonly subscriber: Redis;
  readonly keys: ReturnType<typeof redisKeys>;
  private available = false;
  private stopped = false;
  private connectionError?: unknown;
  onAvailability?: (ready: boolean) => void;
  constructor(url: string, prefix = 'constellate') {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('Configure REDIS_URL with a redis:// or rediss:// URL.'); }
    if (!['redis:', 'rediss:'].includes(parsed.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://.');
    this.keys = redisKeys(prefix);
    const create = () => new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      connectTimeout: 3000, commandTimeout: 4000, retryStrategy: attempt => Math.min(5000, 250 * attempt) });
    this.command = create(); this.publisher = create(); this.subscriber = create();
    for (const client of this.clients) {
      // connect() can reject with a generic "connection closed" error. Preserve
      // the underlying code for startup diagnostics without logging its URL.
      client.on('error', error => { this.connectionError = error; });
      for (const event of ['ready', 'close', 'end'] as const) client.on(event, () => {
        if (this.stopped) return;
        const ready = this.ready;
        if (ready === this.available) return;
        this.available = ready;
        log(ready ? 'info' : 'warn', ready ? 'redis.ready' : 'redis.unavailable', ready ? '[redis] Realtime state service ready.' : '[redis] Realtime state unavailable; retrying with backoff.');
        this.onAvailability?.(ready);
      });
    }
  }
  private get clients() { return [this.command, this.publisher, this.subscriber]; }
  get ready() { return this.clients.every(client => client.status === 'ready'); }
  requireReady() { if (!this.ready) throw new RuntimeUnavailableError(); }
  async connect() {
    try { await Promise.all(this.clients.map(client => client.connect())); }
    catch (error) { this.close(); throw new RuntimeUnavailableError(this.connectionError ?? error); }
  }
  async health() { this.requireReady(); await Promise.all(this.clients.map(client => client.ping())); }
  close() { this.stopped = true; for (const client of this.clients) client.disconnect(); }
}
