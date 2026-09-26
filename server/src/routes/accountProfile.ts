import { Router } from 'express';
import type { AccountProfileRepository } from '../repositories/roomRepository.js';
import { bearerToken, type AccountVerifier } from '../services/supabaseAuth.js';

export function accountProfileRoutes(repository: AccountProfileRepository, verifier?: AccountVerifier) {
  const router = Router();
  router.use(async (request, response, next) => {
    if (!verifier) { response.status(503).json({ error: 'Account profiles are not configured.' }); return; }
    const token = bearerToken(request.header('authorization'));
    const account = token ? await verifier.verify(token) : null;
    if (!account) { response.status(401).json({ error: 'Sign in to manage your profile.' }); return; }
    response.locals.account = account; next();
  });
  router.get('/', async (_request, response, next) => {
    try {
      const profile = await repository.getProfile(response.locals.account.id);
      if (!profile) { response.status(404).json({ error: 'Create your profile to join a room.' }); return; }
      response.json({ profile });
    } catch (error) { next(error); }
  });
  router.put('/', async (request, response, next) => {
    const nickname = typeof request.body?.nickname === 'string' ? request.body.nickname.trim() : '';
    const avatar = request.body?.avatar;
    if (!nickname || nickname.length > 24 || /[\u0000-\u001f\u007f]/.test(nickname)) {
      response.status(400).json({ error: 'Choose a nickname with 1–24 characters.' }); return;
    }
    if (avatar !== 'dark' && avatar !== 'pink' && avatar !== 'green') {
      response.status(400).json({ error: 'Choose a valid avatar.' }); return;
    }
    try { response.json({ profile: await repository.saveProfile(response.locals.account.id, nickname, avatar) }); }
    catch (error) { next(error); }
  });
  return router;
}
