// The original single-process fixture keeps legacy regression tests independent of Redis.
// Production always uses the required shared runtime in src/app.ts.
import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { attachRoomSockets } from '../../src/socket/index.js';
import type { RoomRepository } from '../../src/repositories/roomRepository.js';
import type { StudySessionService } from '../../src/services/studySessionService.js';
import type { PostgresStudySessionRepository } from '../../src/repositories/postgresStudySessionRepository.js';
import { StatsAccess } from '../../src/services/statsAccess.js';
import { statsRoutes } from '../../src/routes/stats.js';

export function createAppServer(allowedOrigins: string[], repository: RoomRepository, graceMs?: number,
  study?: { service: StudySessionService; repository: PostgresStudySessionRepository }) {
  const app = express();
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());
  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/ready', async (_request, response) => {
    try { await repository.health(); response.json({ status: 'ok' }); }
    catch { response.status(503).json({ status: 'unavailable' }); }
  });
  const httpServer = createServer(app);
  const access = new StatsAccess();
  if (study) app.use('/api', statsRoutes(study.repository, study.service, access));
  return { httpServer, ...attachRoomSockets(httpServer, allowedOrigins, repository, graceMs, study?.service, access) };
}
