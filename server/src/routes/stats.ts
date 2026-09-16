import { Router, type Request, type Response } from 'express';
import type { PostgresStudySessionRepository } from '../repositories/postgresStudySessionRepository.js';
import type { StatsAccessProvider } from '../services/statsAccess.js';
import { databaseErrorCode } from '../db/pool.js';

class BadQuery extends Error {}
export function statsRoutes(repository: PostgresStudySessionRepository, studies: { flush(roomId?: string): Promise<void> }, access: StatsAccessProvider) {
  const router = Router();
  const handle = (read: (request: Request, guestId: string, roomId: string) => Promise<unknown>) => async (request: Request, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
    try {
      const scope = token && await access.resolve(token);
      if (!scope) { response.status(401).json({ error: 'Join a room to view your study statistics.' }); return; }
      await studies.flush(scope.roomId);
      const data = await read(request, scope.guestId, scope.roomId);
      // Revocation during the database read must also prevent a response.
      const current = await access.resolve(token!);
      if (!current || current.socketId !== scope.socketId || current.guestId !== scope.guestId || current.roomId !== scope.roomId) { response.status(401).json({ error: 'Reconnect to load your statistics.' }); return; }
      if (data === null) response.status(404).json({ error: 'This room no longer exists.' });
      else response.json(data);
    } catch (error) {
      if (error instanceof BadQuery) response.status(400).json({ error: error.message });
      else { console.error(`[study] Stats query failed (${databaseErrorCode(error)}).`); response.status(503).json({ error: 'Study history is temporarily unavailable. Please try again.' }); }
    }
  };
  router.get('/stats/me', handle(async (request, guestId) => {
    const timezone = request.query.timezone ?? 'UTC';
    if (typeof timezone !== 'string' || timezone.length > 100) throw new BadQuery('Choose a valid timezone.');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new BadQuery('Choose a valid timezone.'); }
    return repository.personal(guestId, timezone);
  }));
  router.get('/stats/me/sessions', handle(async (request, guestId) => {
    const rawLimit = request.query.limit ?? '10';
    if (typeof rawLimit !== 'string' || !/^\d{1,2}$/.test(rawLimit)) throw new BadQuery('History limit must be 1–50.');
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 50) throw new BadQuery('History limit must be 1–50.');
    let before: { at: number; id: string } | undefined;
    if (request.query.cursor !== undefined) {
      const cursor = request.query.cursor;
      try {
        if (typeof cursor !== 'string' || cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!Number.isSafeInteger(decoded.at) || Math.abs(decoded.at) > 8.64e15 || typeof decoded.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(decoded.id)) throw new Error();
        before = { at: decoded.at, id: decoded.id };
      } catch { throw new BadQuery('This history cursor is invalid. Refresh the list.'); }
    }
    return repository.history(guestId, limit, before);
  }));
  router.get('/rooms/:roomId/stats', handle(async (request, _guestId, roomId) => {
    if (request.params.roomId !== roomId) throw new BadQuery('Room statistics are limited to the room you joined.');
    return repository.room(roomId);
  }));
  return router;
}
