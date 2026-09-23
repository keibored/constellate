import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import type { RoomRepository } from './repositories/roomRepository.js';
import type { PostgresStudySessionRepository } from './repositories/postgresStudySessionRepository.js';
import { statsRoutes } from './routes/stats.js';
import type { RedisRoomRuntime } from './redis/roomRuntime.js';
import { RedisStatsAccess } from './redis/statsAccess.js';
import { attachSharedRoomSockets } from './socket/sharedRoom.js';
import { log } from './logger.js';
import { accountRoomRoutes } from './routes/accountRooms.js';
import type { OwnedRoomRepository } from './repositories/roomRepository.js';
import type { AccountVerifier } from './services/supabaseAuth.js';

export async function boundedHealth(check: () => Promise<unknown>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(check), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Health check timeout')), timeoutMs);
    })]);
    return 'ok' as const;
  } catch { return 'unavailable' as const; }
  finally { clearTimeout(timeout); }
}

export function createAppServer(allowedOrigins: string[], repository: RoomRepository,
  shared: { runtime: RedisRoomRuntime; repository: PostgresStudySessionRepository },
  options: { production?: boolean; trustProxy?: number; healthTimeoutMs?: number; accountVerifier?: AccountVerifier } = {}) {
  const app = express();
  let draining = false;
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy ?? 0);
  app.use((request, response, next) => {
    const requestId = randomUUID(), start = performance.now();
    response.set({ 'X-Request-ID': requestId, 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': 'no-store' });
    if (options.production) response.set('Strict-Transport-Security', 'max-age=31536000');
    response.on('finish', () => {
      if (!options.production || (response.statusCode < 400 && ['/api/health', '/api/ready'].includes(request.path))) return;
      log(response.statusCode >= 500 ? 'error' : 'info', 'http.request', 'HTTP request completed.', {
        requestId, method: request.method, route: request.route?.path ?? 'unmatched', status: response.statusCode,
        durationMs: Math.round(performance.now() - start),
      });
    });
    if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) {
      response.status(403).json({ error: 'Origin is not allowed.' }); return;
    }
    next();
  });
  app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600 }));
  app.use(express.json({ limit: '16kb' }));
  // Share in-flight checks so probe bursts do not exhaust the pool during outages.
  let checking: Promise<readonly ['ok' | 'unavailable', 'ok' | 'unavailable']> | undefined;
  const health = async (_request: express.Request, response: express.Response) => {
    if (draining) {
      response.status(503).json({ status: 'unavailable', server: 'draining', database: 'unknown', redis: 'unknown' });
      return;
    }
    checking ??= Promise.all([
      boundedHealth(() => repository.health(), options.healthTimeoutMs ?? 2000),
      boundedHealth(() => shared.runtime.redis.health(), options.healthTimeoutMs ?? 2000),
    ]).finally(() => { checking = undefined; });
    const [database, redis] = await checking;
    const ready = !draining && database === 'ok' && redis === 'ok';
    response.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', server: 'ok', database, redis });
  };
  // /health is the public deployment check; /ready remains a compatible alias.
  app.get('/api/health', health);
  app.get('/api/ready', health);
  app.use((_request, response, next) => {
    if (draining) { response.set('Connection', 'close').status(503).json({ error: 'Server is restarting. Please reconnect.' }); return; }
    next();
  });

  const httpServer = createServer(app);
  const access = new RedisStatsAccess(shared.runtime);
  app.use('/api/account/rooms', accountRoomRoutes(repository as RoomRepository & OwnedRoomRepository, options.accountVerifier));
  app.use('/api', statsRoutes(shared.repository, shared.runtime, access));
  const realtime = attachSharedRoomSockets(httpServer, allowedOrigins, repository, shared.runtime, access, {
    production: options.production, trustProxy: options.trustProxy,
  });
  app.use((_request, response) => { response.status(404).json({ error: 'Not found.' }); });
  const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
    const status = error?.type === 'entity.too.large' ? 413 : error?.type === 'entity.parse.failed' ? 400 : 500;
    response.status(status).json({ error: status === 500 ? 'Internal server error.' : 'Invalid request body.' });
  };
  app.use(handleError);
  httpServer.requestTimeout = 15000;
  httpServer.headersTimeout = 10000;
  httpServer.keepAliveTimeout = 5000;
  return { httpServer, ...realtime, beginDrain: () => { draining = true; realtime.beginDrain(); } };
}
