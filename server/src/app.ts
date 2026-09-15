import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { attachRoomSockets } from './socket/index.js';
import type { RoomRepository } from './repositories/roomRepository.js';
import { databaseErrorCode } from './db/pool.js';
import type { StudySessionService } from './services/studySessionService.js';
import type { PostgresStudySessionRepository } from './repositories/postgresStudySessionRepository.js';
import { StatsAccess } from './services/statsAccess.js';
import { statsRoutes } from './routes/stats.js';

export function createAppServer(allowedOrigins: string[], repository: RoomRepository, graceMs?: number,
  study?: { service: StudySessionService; repository: PostgresStudySessionRepository }) {
  const app = express();
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());
  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/ready', async (_request, response) => {
    try { await repository.health(); response.json({ status: 'ok' }); }
    catch (error) {
      console.error(`[database] Readiness check failed (${databaseErrorCode(error)}).`);
      response.status(503).json({ status: 'unavailable' });
    }
  });

  const httpServer = createServer(app);
  const access = new StatsAccess();
  if (study) app.use('/api', statsRoutes(study.repository, study.service, access));
  const { io, presence, timers, chat } = attachRoomSockets(httpServer, allowedOrigins, repository, graceMs, study?.service, access);
  return { httpServer, io, presence, timers, chat };
}
