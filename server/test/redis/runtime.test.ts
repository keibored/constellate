import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { loadServerEnvironment } from '../../src/config.js';
import { createDatabasePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrations.js';
import { PostgresRoomRepository } from '../../src/repositories/postgresRoomRepository.js';
import { PostgresStudySessionRepository } from '../../src/repositories/postgresStudySessionRepository.js';
import { RedisConnections } from '../../src/redis/connection.js';
import { RedisRoomRuntime } from '../../src/redis/roomRuntime.js';
import { parseRoom, RUNTIME_TIMING } from '../../src/redis/roomState.js';
import { createAppServer } from '../../src/app.js';
import type { ClientToServerEvents, ServerToClientEvents, PresenceList } from '../../../shared/presence.js';
import type { TimerStatePayload } from '../../../shared/timer.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const kei = { id: 'shared-user-kei', nickname: 'kei', avatar: 'dark' as const };
const mika = { id: 'shared-user-mika', nickname: 'mika', avatar: 'pink' as const };
async function until(fn: () => boolean | Promise<boolean>, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!await fn()) { assert.ok(Date.now() < end, label); await delay(20); }
}
async function fixture(t: TestContext) {
  const env = loadServerEnvironment(); assert.ok(env.TEST_DATABASE_URL); assert.ok(env.REDIS_URL, 'Run npm run redis:setup.');
  const suffix = randomBytes(8).toString('hex'), schema = `constellate_test_${suffix}`, prefix = `constellate:test:${suffix}`;
  const admin = createDatabasePool(env.TEST_DATABASE_URL); await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(env.TEST_DATABASE_URL); url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createDatabasePool(url.href), rooms = new PostgresRoomRepository(pool), studies = new PostgresStudySessionRepository(pool);
  const control = new RedisConnections(env.REDIS_URL, prefix); await control.connect();
  const cleanup: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally {
      // Delete only this test's namespace, never FLUSHDB/FLUSHALL.
      const keys = await control.command.keys(`${prefix}:*`); if (keys.length) await control.command.del(...keys);
      control.close(); await pool.end();
      assert.match(schema, /^constellate_test_[a-f0-9]{16}$/);
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
    }
  });
  await migrate(pool);
  const node = async () => {
    const redis = new RedisConnections(env.REDIS_URL!, prefix); await redis.connect();
    const runtime = new RedisRoomRuntime(redis, rooms, studies);
    const app = createAppServer(['http://localhost:5173'], rooms, undefined, undefined, { runtime, repository: studies });
    app.httpServer.listen(0, '127.0.0.1'); await once(app.httpServer, 'listening');
    const address = app.httpServer.address(); assert.ok(address && typeof address !== 'string');
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await new Promise<void>(resolve => app.io.close(() => resolve())); await app.closeRuntime(); redis.close(); };
    cleanup.push(close);
    return { app, redis, runtime, url: `http://127.0.0.1:${address.port}`, close };
  };
  const connect = async (nodeUrl: string, user = kei, roomId = 'demo') => {
    const socket: Client = io(nodeUrl, { autoConnect: false, reconnection: false });
    cleanup.push(() => { socket.disconnect(); });
    const presence: PresenceList[] = [], timers: TimerStatePayload[] = [], reactions: string[] = [], chats: string[] = [], taskRevisions: number[] = [];
    socket.on('presence:list', state => presence.push(state)); socket.on('timer:state', state => timers.push(state));
    socket.on('reaction:new', item => reactions.push(item.id)); socket.on('chat:message', message => chats.push(message.content));
    socket.on('room:state', state => taskRevisions.push(state.revision));
    socket.connect(); await once(socket, 'connect');
    assert.deepEqual(await socket.timeout(5000).emitWithAck('room:join', { roomId, user }), { ok: true });
    return { socket, presence, timers, reactions, chats, taskRevisions };
  };
  return { node, connect, control, rooms, studies, pool, prefix, cleanup };
}

test('two independent runtimes share presence, status, chat, reactions, timer, PostgreSQL tasks and private stats through the Redis adapter', async t => {
  const f = await fixture(t), a = await f.node(), b = await f.node();
  const one = await f.connect(a.url), two = await f.connect(b.url, mika);
  const other = await f.connect(b.url, mika, 'other');
  await until(() => one.presence.at(-1)?.members.length === 2, 'cross-node presence');
  const sessionId = await a.runtime.sessionId('demo', kei.id);
  const tab = await f.connect(b.url);
  assert.equal(tab.presence.at(-1)?.members.length, 2); assert.equal(await b.runtime.sessionId('demo', kei.id), sessionId);
  one.socket.disconnect(); await delay(100);
  assert.equal(two.presence.at(-1)?.members.find(member => member.userId === kei.id)?.connected, true);
  tab.socket.disconnect(); await until(() => two.presence.at(-1)?.members.find(member => member.userId === kei.id)?.connected === false, 'final socket grace');
  const restored = await f.connect(a.url);
  assert.equal(await a.runtime.sessionId('demo', kei.id), sessionId);
  await restored.socket.timeout(5000).emitWithAck('status:update', { roomId: 'demo', userId: kei.id, status: 'reading' });
  await until(() => two.presence.at(-1)?.members.find(member => member.userId === kei.id)?.status === 'reading', 'cross-node status');
  await restored.socket.timeout(5000).emitWithAck('chat:send', { roomId: 'demo', content: 'Across nodes' });
  await restored.socket.timeout(5000).emitWithAck('reaction:send', { roomId: 'demo', kind: 'sparkle' });
  await until(() => two.chats.includes('Across nodes') && two.reactions.length === 1, 'cross-node chat/reaction');
  assert.equal(other.chats.length, 0); assert.equal(other.reactions.length, 0);
  const starts = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? restored.socket : two.socket).timeout(5000).emitWithAck('timer:start', { roomId: 'demo' })));
  assert.ok(starts.every(result => result.ok));
  await until(() => two.timers.at(-1)?.status === 'running', 'cross-node timer');
  const deadline = two.timers.at(-1)!.endsAt;
  assert.equal(restored.timers.at(-1)!.endsAt, deadline); assert.equal(two.timers.at(-1)!.revision, 1);
  await delay(100);
  await two.socket.timeout(5000).emitWithAck('timer:pause', { roomId: 'demo' });
  await a.runtime.checkpoint('demo');
  const focus = (await f.studies.personal(kei.id, 'UTC')).overall.focusSeconds;
  assert.ok(focus > 0); await delay(100); await b.runtime.checkpoint('demo');
  assert.equal((await f.studies.personal(kei.id, 'UTC')).overall.focusSeconds, focus);
  await restored.socket.timeout(5000).emitWithAck('task:create', { roomId: 'demo', title: 'Shared task', requestId: randomUUID() });
  const task = (await f.rooms.load('demo')).tasks[0];
  for (const completed of [true, false, true]) assert.deepEqual(await two.socket.timeout(5000).emitWithAck('task:toggle', { roomId: 'demo', taskId: task.id, completed }), { ok: true });
  await until(() => restored.taskRevisions.at(-1) === 4, 'task broadcast after PostgreSQL commit');
  assert.equal((await f.studies.personal(mika.id, 'UTC')).overall.completedTasks, 1);
  assert.equal((await f.studies.personal(kei.id, 'UTC')).overall.completedTasks, 0);
  const access = await restored.socket.timeout(5000).emitWithAck('stats:access', { roomId: 'demo' }); assert.ok(access.ok);
  const response = await fetch(`${b.url}/api/stats/me?guestId=${mika.id}`, { headers: { Authorization: `Bearer ${access.token}` } });
  assert.equal(response.status, 200); assert.equal((await response.json()).overall.completedTasks, 0, 'HTTP can use another node without exposing another guest');
  const late = await f.connect(b.url, { ...mika, id: 'shared-user-late' });
  assert.equal(late.timers.at(-1)?.status, 'paused');
  await restored.socket.timeout(5000).emitWithAck('room:leave', { roomId: 'demo' });
  assert.equal((await fetch(`${b.url}/api/stats/me`, { headers: { Authorization: `Bearer ${access.token}` } })).status, 401);
  await a.runtime.flush('demo'); assert.ok((await f.studies.history(kei.id, 10)).sessions[0].endedAt);
});

test('concurrent completion workers and replayed accounting count one Pomodoro; restart recovers deadlines and deletion removes runtime', async t => {
  const f = await fixture(t), a = await f.node(), b = await f.node();
  const one = await f.connect(a.url), two = await f.connect(b.url, mika);
  await one.socket.timeout(5000).emitWithAck('timer:start', { roomId: 'demo' });
  await a.runtime.flush('demo');
  const key = f.control.keys.room('demo');
  const state = parseRoom((await f.control.command.hget(key, 'state'))!, 'demo');
  const deadline = state.timer.endsAt;
  await a.close();
  const replacement = await f.node();
  const rejoined = await f.connect(replacement.url);
  assert.equal(rejoined.timers.at(-1)?.endsAt, deadline);
  assert.equal((await f.studies.personal(kei.id, 'UTC')).overall.sessions, 1);
  await replacement.runtime.flush('demo');
  const before = parseRoom((await f.control.command.hget(key, 'state'))!, 'demo');
  // Advance only this isolated fixture's deadline, leaving production 25/5 defaults intact.
  before.timer.endsAt = Date.now() - 1;
  await f.control.command.hset(key, 'state', JSON.stringify(before), 'version', randomUUID());
  await Promise.all([b.runtime.act('demo', { kind: 'sweep' }), replacement.runtime.act('demo', { kind: 'sweep' })]);
  await Promise.all([b.runtime.flush('demo'), replacement.runtime.flush('demo')]);
  assert.equal((await f.studies.personal(kei.id, 'UTC')).overall.completedPomodoros, 1);
  assert.equal((await f.studies.personal(mika.id, 'UTC')).overall.completedPomodoros, 1);
  assert.equal((await f.studies.room('demo'))?.completedPomodoros, 1);
  await two.socket.timeout(5000).emitWithAck('timer:sync', { roomId: 'demo' });
  assert.equal(two.timers.at(-1)?.phase, 'shortBreak');
  await f.pool.query('DELETE FROM rooms WHERE id = $1', ['demo']);
  assert.equal((await rejoined.socket.timeout(5000).emitWithAck('timer:sync', { roomId: 'demo' })).ok, false);
  assert.equal(await f.control.command.exists(key), 0);
  assert.equal(await f.control.command.zscore(f.control.keys.due, 'demo'), null);
});

test('Redis connection failure fails readiness and closes local transports; reconnect uses Redis state without a memory fallback', async t => {
  const f = await fixture(t), a = await f.node(), b = await f.node();
  const one = await f.connect(a.url), two = await f.connect(b.url, mika);
  await one.socket.timeout(5000).emitWithAck('timer:start', { roomId: 'demo' });
  const deadline = one.timers.at(-1)!.endsAt;
  a.redis.command.disconnect();
  await until(() => !one.socket.connected, 'failed dependency closes transport');
  assert.equal((await fetch(`${a.url}/api/ready`)).status, 503);
  assert.equal((await fetch(`${b.url}/api/ready`)).status, 200);
  await assert.rejects(a.runtime.act('demo', { kind: 'sweep' }));
  await a.redis.command.connect();
  await until(() => a.redis.ready, 'Redis reconnect');
  const restored = await f.connect(a.url);
  assert.equal(restored.timers.at(-1)?.endsAt, deadline);
  assert.equal(restored.presence.at(-1)?.members.length, 2);
  await restored.socket.timeout(5000).emitWithAck('reaction:send', { roomId: 'demo', kind: 'coffee' });
  await until(() => two.reactions.length === 1, 'adapter still works after Redis reconnect');
  assert.equal((await fetch(`${a.url}/api/ready`)).status, 200);
});
