import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { io } from 'socket.io-client';
import { createAppServer } from '../src/app.js';
import { connectRoom, type ConnectionStatus } from '../../client/src/services/roomConnection.js';
import type { RoomSocket } from '../../client/src/services/socket.js';
import type { MemberPresence, RoomUser } from '../../shared/presence.js';

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(10); }
}

test('the actual Vite proxy carries polling, WebSocket, acknowledged room joins, reconnects, chat and independent rooms', async t => {
  const origins: string[] = [];
  const server = createAppServer(origins, 500);
  t.after(() => new Promise<void>(resolve => server.io.close(() => resolve())));
  server.httpServer.listen(0, '127.0.0.1');
  await once(server.httpServer, 'listening');
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const target = `http://127.0.0.1:${address.port}`;
  const vite = await createViteServer({
    root: fileURLToPath(new URL('../../client', import.meta.url)),
    configFile: fileURLToPath(new URL('../../client/vite.config.ts', import.meta.url)),
    // This test serves the app from the server workspace; it checks transport,
    // while the normal client build verifies the workspace's CSS pipeline.
    css: { postcss: { plugins: [] } },
    server: {
      host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null,
      proxy: { '/socket.io': { target }, '/api': { target } },
    },
    logLevel: 'error',
  });
  t.after(() => vite.close());
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
    const state = { connection: 'idle' as ConnectionStatus, members: [] as MemberPresence[], history: false, timer: false, messages: [] as string[] };
    socket.on('presence:list', event => { if (event.roomId === roomId) state.members = event.members; });
    socket.on('presence:updated', event => {
      if (event.roomId === roomId) state.members = state.members.map(member => member.userId === event.member.userId ? event.member : member);
    });
    socket.on('chat:history', () => { state.history = true; });
    socket.on('timer:state', () => { state.timer = true; });
    socket.on('chat:message', message => state.messages.push(message.content));
    const subscription = connectRoom(socket, roomId, user, {
      connection: status => { state.connection = status; }, error: () => {}, disconnected: () => {},
    });
    t.after(() => subscription.dispose());
    await until(() => state.connection === 'connected', 'acknowledged room connection through Vite');
    assert.equal(state.history, true);
    assert.equal(state.timer, true);
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

  const original = { ...b.state.members.find(member => member.userId === mika.id)! };
  const previousSocketId = b.socket.id;
  b.socket.io.engine.close();
  await until(() => b.state.connection === 'connected' && b.socket.id !== previousSocketId, 'automatic transport reconnect');
  assert.deepEqual(b.state.members.find(member => member.userId === mika.id), original);
  b.socket.disconnect();
  await until(() => a.state.members.length === 1, 'final disconnect grace removal');
  assert.equal(a.state.members[0].deskId, 'desk-1');
  a.socket.disconnect();
  await delay(550);
  assert.equal(server.presence.list('demo').length, 1, 'another tab still owns the same user');
});
