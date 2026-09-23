import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { accountRoomRoutes } from '../src/routes/accountRooms.js';
import type { OwnedRoomRepository } from '../src/repositories/roomRepository.js';
import type { AccountVerifier } from '../src/services/supabaseAuth.js';

const rooms = new Map<string, Array<{ id: string; name: string; visibility: 'public'; createdAt: number; updatedAt: number }>>();
const repository: OwnedRoomRepository = {
  async listOwned(owner) { return rooms.get(owner) ?? []; },
  async createOwned(id, owner, name) {
    const room = { id, name, visibility: 'public' as const, createdAt: Date.now(), updatedAt: Date.now() };
    rooms.set(owner, [room, ...(rooms.get(owner) ?? [])]); return room;
  },
};
const verifier: AccountVerifier = { verify: async token => token === 'valid.token' ? { id: '11111111-1111-4111-8111-111111111111' } : null };

async function server() {
  const app = express(); app.use(express.json()); app.use('/rooms', accountRoomRoutes(repository, verifier));
  const instance = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => instance.once('listening', resolve));
  const address = instance.address();
  return { url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, close: () => new Promise<void>(resolve => instance.close(() => resolve())) };
}

test('owned-room routes require a verified account and scope lists to its owner', async () => {
  const app = await server();
  try {
    assert.equal((await fetch(`${app.url}/rooms`)).status, 401);
    assert.equal((await fetch(`${app.url}/rooms`, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    const created = await fetch(`${app.url}/rooms`, { method: 'POST', headers: { Authorization: 'Bearer valid.token', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Night owls' }) });
    assert.equal(created.status, 201);
    const listed = await fetch(`${app.url}/rooms`, { headers: { Authorization: 'Bearer valid.token' } });
    assert.deepEqual((await listed.json() as { rooms: Array<{ name: string }> }).rooms.map(room => room.name), ['Night owls']);
  } finally { await app.close(); rooms.clear(); }
});
