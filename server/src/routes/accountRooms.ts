import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { OwnedRoomRepository } from '../repositories/roomRepository.js';
import { RoomStateError } from '../repositories/roomRepository.js';
import { bearerToken, type AccountVerifier } from '../services/supabaseAuth.js';

const roomId = () => `room-${randomBytes(5).toString('hex')}`;

export function accountRoomRoutes(repository: OwnedRoomRepository, verifier?: AccountVerifier) {
  const router = Router();
  router.use(async (request, response, next) => {
    if (!verifier) { response.status(503).json({ error: 'Account rooms are not configured.' }); return; }
    const token = bearerToken(request.header('authorization'));
    const account = token ? await verifier.verify(token) : null;
    if (!account) { response.status(401).json({ error: 'Sign in to manage your rooms.' }); return; }
    response.locals.account = account; next();
  });
  router.get('/', async (_request, response, next) => {
    try { response.json({ rooms: await repository.listOwned(response.locals.account.id) }); }
    catch (error) { next(error); }
  });
  router.post('/', async (request, response, next) => {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (!name || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name)) {
      response.status(400).json({ error: 'Choose a room name with 1–32 characters.' }); return;
    }
    try { response.status(201).json({ room: await repository.createOwned(roomId(), response.locals.account.id, name) }); }
    catch (error) {
      if (error instanceof RoomStateError) { response.status(409).json({ error: error.message }); return; }
      next(error);
    }
  });
  return router;
}
