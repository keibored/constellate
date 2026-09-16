import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { createAppServer } from './helpers/appServer.js';
import { TestRoomRepository } from './helpers/testRoomRepository.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/presence.js';
import type { RoomStatePayload } from '../../shared/roomState.js';

async function fixture(t: TestContext, repository: TestRoomRepository) {
  const app = createAppServer(['http://localhost:5173'], repository, 50);
  app.httpServer.listen(0, '127.0.0.1'); await once(app.httpServer, 'listening');
  const address = app.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const socket: Socket<ClientToServerEvents, ServerToClientEvents> = io(url, { autoConnect: false, reconnection: false });
  t.after(async () => { socket.disconnect(); await new Promise<void>(resolve => app.io.close(() => resolve())); });
  socket.connect(); await once(socket, 'connect');
  return { app, socket, url };
}
const user = { id: 'test-persist-user', nickname: 'kei', avatar: 'dark' as const };

test('database mutation failure rejects the acknowledgement without broadcasting unsaved state or disrupting presence/timer/chat', async t => {
  const repository = new TestRoomRepository();
  const f = await fixture(t, repository);
  await f.socket.timeout(2000).emitWithAck('room:join', { roomId: 'demo', user });
  const states: RoomStatePayload[] = [];
  f.socket.on('room:state', state => states.push(state));
  t.mock.method(repository, 'mutate', async () => { throw Object.assign(new Error('database unavailable'), { code: '08006' }); });
  const logs: string[] = [];
  t.mock.method(console, 'error', (message: string) => { logs.push(message); });
  const result = await f.socket.timeout(2000).emitWithAck('task:create', { roomId: 'demo', title: 'Unsaved', requestId: randomUUID() });
  assert.equal(result.ok, false);
  assert.deepEqual(states, []);
  assert.deepEqual((await repository.load('demo')).tasks, []);
  assert.equal(f.app.presence.list('demo').length, 1);
  assert.deepEqual(await f.socket.timeout(2000).emitWithAck('timer:start', { roomId: 'demo' }), { ok: true });
  assert.deepEqual(await f.socket.timeout(2000).emitWithAck('chat:send', { roomId: 'demo', content: 'still connected' }), { ok: true });
  t.mock.method(repository, 'health', async () => { throw new Error('offline'); });
  assert.equal((await fetch(`${f.url}/api/ready`)).status, 503);
  assert.equal((await fetch(`${f.url}/api/health`)).status, 200);
  assert.ok(logs.some(log => log.includes('task:create failed (08006)')));
});

test('a delayed database join cannot resurrect membership after leave or a newer room join', async t => {
  const repository = new TestRoomRepository();
  const originalLoad = repository.load.bind(repository);
  const pending: (() => Promise<void>)[] = [];
  repository.load = roomId => new Promise(resolve => { pending.push(async () => resolve(await originalLoad(roomId))); });
  const f = await fixture(t, repository);
  const first = f.socket.timeout(2000).emitWithAck('room:join', { roomId: 'old-room', user });
  await f.socket.timeout(2000).emitWithAck('room:leave', { roomId: 'old-room' });
  await pending.shift()!();
  assert.equal((await first).ok, false);
  assert.deepEqual(f.app.presence.list('old-room'), []);
  const stale = f.socket.timeout(2000).emitWithAck('room:join', { roomId: 'old-room', user });
  const next = f.socket.timeout(2000).emitWithAck('room:join', { roomId: 'new-room', user });
  // An acknowledged unrelated event guarantees both joins reached the server.
  await f.socket.timeout(2000).emitWithAck('timer:sync', { roomId: 'new-room' });
  await pending[1]();
  assert.deepEqual(await next, { ok: true });
  await pending[0]();
  assert.equal((await stale).ok, false);
  assert.deepEqual(f.app.presence.list('old-room'), []);
  assert.equal(f.app.presence.list('new-room').length, 1);
});
