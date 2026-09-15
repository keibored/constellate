import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createLogger, createServer as createViteServer } from 'vite';
import { io } from 'socket.io-client';
import { createAppServer } from '../src/app.js';
import { TestRoomRepository } from './helpers/testRoomRepository.js';
import { connectRoom, type ConnectionStatus } from '../../client/src/services/roomConnection.js';
import type { RoomSocket } from '../../client/src/services/socket.js';
import type { MemberPresence, RoomUser } from '../../shared/presence.js';
import type { TimerStatePayload } from '../../shared/timer.js';

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(10); }
}

test('the actual Vite proxy carries polling, WebSocket, acknowledged room joins, reconnects, chat and independent rooms', async t => {
  const origins: string[] = [];
  const server = createAppServer(origins, new TestRoomRepository(), 500);
  t.after(() => new Promise<void>(resolve => server.io.close(() => resolve())));
  server.httpServer.listen(0, '127.0.0.1');
  await once(server.httpServer, 'listening');
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const target = `http://127.0.0.1:${address.port}`;
  const previousPort = process.env.PORT;
  const previousTarget = process.env.SERVER_PROXY_TARGET;
  process.env.PORT = String(address.port);
  process.env.SERVER_PROXY_TARGET = '';
  t.after(() => {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousTarget === undefined) delete process.env.SERVER_PROXY_TARGET;
    else process.env.SERVER_PROXY_TARGET = previousTarget;
  });
  const proxyErrors: string[] = [];
  const logger = createLogger('error');
  logger.error = message => { proxyErrors.push(message); };
  const vite = await createViteServer({
    root: fileURLToPath(new URL('../../client', import.meta.url)),
    configFile: fileURLToPath(new URL('../../client/vite.config.ts', import.meta.url)),
    // This test serves the app from the server workspace; it checks transport,
    // while the normal client build verifies the workspace's CSS pipeline.
    css: { postcss: { plugins: [] } },
    server: {
      host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null,
    },
    logLevel: 'error',
    customLogger: logger,
  });
  t.after(() => vite.close());
  for (const path of ['/api', '/socket.io']) {
    const proxy = vite.config.server.proxy?.[path];
    assert.ok(proxy && typeof proxy !== 'string');
    assert.equal(proxy.target, target, 'the actual config derives both targets from backend PORT');
    if (path === '/socket.io') assert.equal(proxy.ws, true);
  }
  await vite.listen();
  const viteAddress = vite.httpServer?.address();
  assert.ok(viteAddress && typeof viteAddress !== 'string');
  const url = `http://127.0.0.1:${viteAddress.port}`;
  origins.push(url);
  assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { status: 'ok' });
  for (const path of ['/r/demo', '/r/test-room', '/room/demo']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /src\/main.tsx/);
  }
  const appSource = await (await fetch(`${url}/src/App.tsx`)).text();
  assert.match(appSource, /r\|room/);

  const participant = async (user: RoomUser, roomId = 'demo') => {
    const socket: RoomSocket = io(url, {
      autoConnect: false, forceNew: true, extraHeaders: { Origin: url },
      reconnectionDelay: 10, reconnectionDelayMax: 50, randomizationFactor: 0,
    });
    const state = { connection: 'idle' as ConnectionStatus, members: [] as MemberPresence[], history: false, timer: null as TimerStatePayload | null, timerEvents: 0, messages: [] as string[] };
    socket.on('presence:list', event => { if (event.roomId === roomId) state.members = event.members; });
    socket.on('presence:updated', event => {
      if (event.roomId === roomId) state.members = state.members.map(member => member.userId === event.member.userId ? event.member : member);
    });
    socket.on('chat:history', () => { state.history = true; });
    socket.on('timer:state', snapshot => { state.timer = snapshot; state.timerEvents++; });
    socket.on('chat:message', message => state.messages.push(message.content));
    const subscription = connectRoom(socket, roomId, user, {
      connection: status => { state.connection = status; }, error: () => {}, disconnected: () => {},
    });
    t.after(() => subscription.dispose());
    await until(() => state.connection === 'connected', 'acknowledged room connection through Vite');
    assert.equal(state.history, true);
    assert.ok(state.timer);
    await until(() => socket.io.engine.transport.name === 'websocket', 'polling upgrades through Vite WebSocket proxy');
    return { socket, state };
  };
  const kei: RoomUser = { id: 'proxy-user-kei', nickname: 'kei', avatar: 'dark' };
  const mika: RoomUser = { id: 'proxy-user-mika', nickname: 'mika', avatar: 'pink' };
  const a = await participant(kei);
  assert.equal(a.state.members.length, 1);
  assert.equal(a.state.members[0].deskId, 'desk-1');
  const b = await participant(mika);
  await until(() => a.state.members.length === 2, 'two-member snapshot');
  const sameUserTab = await participant(kei);
  assert.equal(sameUserTab.state.members.length, 2);
  const isolated = await participant(mika, 'test-room');
  assert.equal(isolated.state.members.length, 1);
  assert.equal(isolated.state.members[0].userId, mika.id);
  for (const [client, observer, userId, status] of [
    [a, b, kei.id, 'coding'],
    [b, a, mika.id, 'reading'],
    [b, a, mika.id, 'break'],
  ] as const) {
    assert.deepEqual(await client.socket.timeout(2_000).emitWithAck('status:update', { roomId: 'demo', userId, status }), { ok: true });
    await until(() => observer.state.members.find(member => member.userId === userId)?.status === status, `${status} reaches the room peer`);
  }
  assert.equal(isolated.state.members[0].status, 'coding');
  assert.deepEqual(await a.socket.timeout(2_000).emitWithAck('chat:send', { roomId: 'demo', content: 'proxy smoke test' }), { ok: true });
  await until(() => b.state.messages.length === 1, 'existing chat through proxy');
  assert.deepEqual(isolated.state.messages, []);

  for (const [client, action, expected] of [
    [a, 'timer:start', 'running'], [b, 'timer:pause', 'paused'],
    [a, 'timer:resume', 'running'], [b, 'timer:reset', 'idle'],
  ] as const) {
    assert.deepEqual(await client.socket.timeout(2_000).emitWithAck(action, { roomId: 'demo' }), { ok: true });
    await until(() => a.state.timer?.status === expected && b.state.timer?.status === expected, `${action} syncs through Vite`);
    assert.equal(a.state.timer?.revision, b.state.timer?.revision);
  }
  assert.equal(isolated.state.timer?.status, 'idle');

  const beforeStart = a.state.timer!.revision;
  const starts = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    [a, sameUserTab][index % 2].socket.timeout(2_000).emitWithAck('timer:start', { roomId: 'demo' })));
  assert.ok(starts.every(result => result.ok));
  await until(() => b.state.timer?.status === 'running', 'rapid Start requests reach the observer');
  const running = { ...b.state.timer! };
  assert.equal(running.revision, beforeStart + 1, 'rapid Start requests create one timer run');
  const eventCounts = [a, b, sameUserTab].map(client => client.state.timerEvents);
  await delay(1_100);
  assert.deepEqual([a, b, sameUserTab].map(client => client.state.timerEvents), eventCounts, 'no per-second countdown events');
  assert.equal(isolated.state.timer?.status, 'idle');

  const original = { ...b.state.members.find(member => member.userId === mika.id)! };
  const previousSocketId = b.socket.id;
  b.socket.io.engine.close();
  await until(() => b.state.connection === 'connected' && b.socket.id !== previousSocketId, 'automatic transport reconnect');
  assert.deepEqual(b.state.members.find(member => member.userId === mika.id), original);
  assert.equal(b.state.members.length, 2, 'reconnect does not duplicate members');
  assert.equal(b.state.timer?.endsAt, running.endsAt, 'reconnect retains the server deadline');
  assert.equal(b.state.timer?.revision, running.revision);
  assert.ok(b.state.timer!.remainingMs < running.remainingMs - 1_000, 'reconnect receives elapsed time, not a reset');
  await until(() => server.io.engine.clientsCount === 4, 'reconnect replaces the old transport without leaking connections');
  b.socket.disconnect();
  await until(() => a.state.members.length === 1, 'final disconnect grace removal');
  assert.equal(a.state.members[0].deskId, 'desk-1');
  const returned = await participant(mika);
  assert.equal(returned.state.timer?.endsAt, running.endsAt, 'closing and rejoining after grace keeps the running timer');
  assert.equal(returned.state.timer?.status, 'running');
  assert.equal(returned.state.members.length, 2);
  returned.socket.disconnect();
  a.socket.disconnect();
  await delay(550);
  assert.equal(server.presence.list('demo').length, 1, 'another tab still owns the same user');
  assert.deepEqual(proxyErrors, [], 'Vite must not log ECONNREFUSED or other proxy errors');
});
