import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import type { RoomRepository } from './repositories/roomRepository.js';
import type { PostgresStudySessionRepository } from './repositories/postgresStudySessionRepository.js';
import { statsRoutes } from './routes/stats.js';
import type { RedisRoomRuntime } from './redis/roomRuntime.js';
import { RedisStatsAccess } from './redis/statsAccess.js';
import { attachSharedRoomSockets } from './socket/sharedRoom.js';

export function createAppServer(allowedOrigins: string[], repository: RoomRepository,
  shared: { runtime: RedisRoomRuntime; repository: PostgresStudySessionRepository }) {
  const app = express();
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());
  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/ready', async (_request, response) => {
    const [database, redis] = await Promise.allSettled([repository.health(), shared.runtime.redis.health()]);
    const ready = database.status === 'fulfilled' && redis.status === 'fulfilled';
    response.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', database: database.status === 'fulfilled' ? 'ok' : 'unavailable', redis: redis.status === 'fulfilled' ? 'ok' : 'unavailable' });
  });

  const httpServer = createServer(app);
  const access = new RedisStatsAccess(shared.runtime);
  app.use('/api', statsRoutes(shared.repository, shared.runtime, access));
  const realtime = attachSharedRoomSockets(httpServer, allowedOrigins, repository, shared.runtime, access);
  return { httpServer, ...realtime };
}
