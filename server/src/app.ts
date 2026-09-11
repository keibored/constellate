import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { attachRoomSockets } from './socket/index.js';

export function createAppServer(allowedOrigins: string[], graceMs?: number) {
  const app = express();
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());
  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }));

  const httpServer = createServer(app);
  const { io, presence, timers, chat } = attachRoomSockets(httpServer, allowedOrigins, graceMs);
  return { httpServer, io, presence, timers, chat };
}
