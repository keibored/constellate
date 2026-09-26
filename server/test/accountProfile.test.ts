import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { accountProfileRoutes } from '../src/routes/accountProfile.js';
import type { AccountProfile, AccountProfileRepository } from '../src/repositories/roomRepository.js';
import type { AccountVerifier } from '../src/services/supabaseAuth.js';

const profiles = new Map<string, AccountProfile>();
const repository: AccountProfileRepository = {
  async getProfile(userId) { return profiles.get(userId) ?? null; },
  async saveProfile(userId, nickname, avatar) {
    const profile = { nickname, avatar, updatedAt: Date.now() };
    profiles.set(userId, profile); return profile;
  },
};
const accountId = '11111111-1111-4111-8111-111111111111';
const verifier: AccountVerifier = { verify: async token => token === 'valid.token' ? { id: accountId } : null };

async function server() {
  const app = express(); app.use(express.json()); app.use('/profile', accountProfileRoutes(repository, verifier));
  const instance = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => instance.once('listening', resolve));
  const address = instance.address();
  return { url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    close: () => new Promise<void>(resolve => instance.close(() => resolve())) };
}

test('account profile routes require authentication and persist a scoped profile', async () => {
  const app = await server();
  const authorization = { Authorization: 'Bearer valid.token' };
  try {
    assert.equal((await fetch(`${app.url}/profile`)).status, 401);
    assert.equal((await fetch(`${app.url}/profile`, { headers: authorization })).status, 404);
    const invalid = await fetch(`${app.url}/profile`, { method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: '', avatar: 'blue' }) });
    assert.equal(invalid.status, 400);
    const saved = await fetch(`${app.url}/profile`, { method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: '  kei  ', avatar: 'pink' }) });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json() as { profile: AccountProfile }).profile.nickname, 'kei');
    const loaded = await fetch(`${app.url}/profile`, { headers: authorization });
    assert.deepEqual((await loaded.json() as { profile: AccountProfile }).profile.avatar, 'pink');
  } finally { await app.close(); profiles.clear(); }
});
