import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { loadServerEnvironment } from '../../src/config.js';
import { createDatabasePool } from '../../src/db/pool.js';
import { assertMigrationsCurrent, migrate } from '../../src/db/migrations.js';
import { PostgresRoomRepository } from '../../src/repositories/postgresRoomRepository.js';
import { createAppServer } from '../helpers/appServer.js';
import { RedisConnections } from '../../src/redis/connection.js';
import type { ClientToServerEvents, ServerToClientEvents, RoomUser } from '../../../shared/presence.js';
import type { RoomStatePayload } from '../../../shared/roomState.js';

const kei: RoomUser = { id: 'database-user-kei', nickname: 'kei', avatar: 'dark' };
const mika: RoomUser = { id: 'database-user-mika', nickname: 'mika', avatar: 'pink' };
const origin = 'http://localhost:5173';
type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
async function until(condition: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 12_000;
  while (!(await condition())) { assert.ok(Date.now() < end, label); await delay(20); }
}

async function fixture(t: TestContext) {
  const connectionString = loadServerEnvironment().TEST_DATABASE_URL;
  assert.ok(connectionString, 'Set TEST_DATABASE_URL in server/.env (db:setup generates a separate test database).');
  const admin = createDatabasePool(connectionString);
  const schema = `constellate_test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connectionString);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createDatabasePool(url.href);
  const cleanup: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally {
      await pool.end();
      // Drop only the uniquely named schema created by this fixture.
      assert.match(schema, /^constellate_test_[a-f0-9]{16}$/);
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
  return { pool, url: url.href, cleanup, repository: new PostgresRoomRepository(pool) };
}

test('SQL migrations are repeatable; room transactions persist metadata/tasks, serialize writes and enforce foreign keys', async t => {
  const f = await fixture(t);
  await assert.rejects(assertMigrationsCurrent(f.pool), /schema is missing/);
  assert.deepEqual(await migrate(f.pool), ['001_create_rooms.sql', '002_create_tasks.sql', '003_study_sessions.sql']);
  assert.deepEqual(await migrate(f.pool), []);
  await assertMigrationsCurrent(f.pool);
  assert.equal((await f.repository.load('demo')).room.name, 'Late night grind');
  const operation = { kind: 'create' as const, title: "Review SQL '; DROP TABLE rooms; --", requestId: randomUUID(), creator: kei };
  const first = await f.repository.mutate('demo', operation);
  assert.equal(first.tasks[0].title, operation.title, 'text is parameterized, not SQL');
  assert.equal((await f.repository.mutate('demo', operation)).revision, first.revision, 'duplicate creation is idempotent');
  await assert.rejects(f.repository.mutate('demo', { ...operation, creator: mika }), /already used/);
  await Promise.all(Array.from({ length: 12 }, (_, i) => f.repository.mutate('demo', { kind: 'create', title: `Concurrent ${i}`, requestId: randomUUID(), creator: kei })));
  const all = await f.repository.load('demo');
  assert.equal(all.tasks.length, 13);
  assert.equal(all.revision, 13);
  const completed = await f.repository.mutate('demo', { kind: 'toggle', taskId: first.tasks[0].id, completed: true });
  assert.equal((await f.repository.mutate('demo', { kind: 'toggle', taskId: first.tasks[0].id, completed: true })).revision, completed.revision);
  await f.repository.mutate('demo', { kind: 'rename', name: 'Saved study room' });
  const freshPool = createDatabasePool(f.url);
  try {
    const restored = await new PostgresRoomRepository(freshPool).load('demo');
    assert.equal(restored.room.name, 'Saved study room');
    assert.equal(restored.tasks.length, 13);
    assert.equal(restored.tasks[0].completed, true);
  } finally { await freshPool.end(); }
  assert.deepEqual((await f.repository.load('other')).tasks, []);
  await assert.rejects(f.repository.mutate('other', { kind: 'delete', taskId: first.tasks[0].id }), /no longer exists/);
  await f.pool.query('DELETE FROM rooms WHERE id = $1', ['demo']);
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM tasks WHERE room_id = $1', ['demo'])).rows[0].count, 0);
  await assert.rejects(f.repository.load('demo', false), /no longer exists/);
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM rooms WHERE id = $1', ['demo'])).rows[0].count, 0, 'recovery cannot recreate a deleted room');
  const columns = await f.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('rooms', 'tasks')`);
  assert.ok(columns.rows.every(row => !/socket|online|connected|presence/.test(row.column_name)), 'live presence is not stored');
  await f.pool.query("UPDATE schema_migrations SET checksum = 'changed' WHERE version = $1", ['001_create_rooms.sql']);
  await assert.rejects(migrate(f.pool), /Applied migration .* changed/);
});

test('real PostgreSQL Socket.IO actions synchronize after commit, validate ownership and keep rooms isolated', async t => {
  const f = await fixture(t);
  await migrate(f.pool);
  const app = createAppServer([origin], f.repository, 80);
  f.cleanup.push(() => new Promise<void>(resolve => app.io.close(() => resolve())));
  app.httpServer.listen(0, '127.0.0.1');
  await once(app.httpServer, 'listening');
  const address = app.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const connect = async (user?: RoomUser, roomId = 'demo') => {
    const socket: Client = io(url, { autoConnect: false, forceNew: true, reconnection: false, extraHeaders: { Origin: origin } });
    f.cleanup.push(() => { socket.disconnect(); });
    const states: RoomStatePayload[] = [];
    socket.on('room:state', state => states.push(state));
    socket.connect(); await once(socket, 'connect');
    if (user) assert.deepEqual(await socket.timeout(3_000).emitWithAck('room:join', { roomId, user }), { ok: true });
    return { socket, states };
  };
  const a = await connect(kei), b = await connect(mika), other = await connect(mika, 'other'), stranger = await connect();
  assert.equal((await fetch(`${url}/api/ready`)).status, 200);
  assert.equal((await stranger.socket.timeout(2000).emitWithAck('task:create', { roomId: 'demo', title: 'No access', requestId: randomUUID() })).ok, false);
  assert.equal((await other.socket.timeout(2000).emitWithAck('tasks:sync', { roomId: 'demo' })).ok, false);
  const requestId = randomUUID();
  assert.deepEqual(await a.socket.timeout(2000).emitWithAck('task:create', { roomId: 'demo', title: 'Read WebSocket notes', requestId, createdBy: mika.id } as never), { ok: true });
  await until(() => b.states.at(-1)?.tasks.length === 1, 'B receives A task');
  const task = b.states.at(-1)!.tasks[0];
  assert.equal(task.createdBy, kei.id, 'sender metadata is derived from joined presence');
  assert.equal((await f.repository.load('demo')).tasks[0].id, task.id, 'broadcast describes a committed row');
  assert.deepEqual(other.states.at(-1)?.tasks, []);
  await b.socket.timeout(2000).emitWithAck('task:toggle', { roomId: 'demo', taskId: task.id, completed: true });
  await until(() => a.states.at(-1)?.tasks[0].completed === true, 'A sees B completion');
  await a.socket.timeout(2000).emitWithAck('room:rename', { roomId: 'demo', name: 'Night study' });
  await until(() => b.states.at(-1)?.room.name === 'Night study', 'room rename syncs');
  assert.equal((await other.socket.timeout(2000).emitWithAck('task:delete', { roomId: 'other', taskId: task.id })).ok, false);
  for (const title of ['', '   ', 'x'.repeat(101), 'bad\u0000title']) {
    assert.equal((await a.socket.timeout(2000).emitWithAck('task:create', { roomId: 'demo', title, requestId: randomUUID() })).ok, false);
  }
  assert.equal((await a.socket.timeout(2000).emitWithAck('task:toggle', { roomId: 'demo', taskId: task.id, completed: 'yes' } as never)).ok, false);
  const refreshed = await connect(mika);
  assert.equal(refreshed.states.at(-1)?.tasks[0].completed, true);
  assert.equal(app.presence.list('demo').length, 2);
  await a.socket.timeout(2000).emitWithAck('task:delete', { roomId: 'demo', taskId: task.id });
  await until(() => b.states.at(-1)?.tasks.length === 0, 'B receives deletion');
  assert.deepEqual((await f.repository.load('demo')).tasks, []);
  assert.deepEqual(await a.socket.timeout(2000).emitWithAck('timer:start', { roomId: 'demo' }), { ok: true });
  assert.equal(app.timers.current('demo').status, 'running');
  assert.deepEqual(await b.socket.timeout(2000).emitWithAck('chat:send', { roomId: 'demo', content: 'still here' }), { ok: true });
  await f.pool.query('DELETE FROM rooms WHERE id = $1', ['other']);
  const missing = await stranger.socket.timeout(2000).emitWithAck('room:join', { roomId: 'other', user: kei, restore: true });
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.code, 'ROOM_NOT_FOUND');
  assert.equal((await other.socket.timeout(2000).emitWithAck('tasks:sync', { roomId: 'other' })).ok, false);
  assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM rooms WHERE id = $1', ['other'])).rows[0].count, 0);
});

test('room name, tasks and completion survive stopping and restarting the actual backend process', async t => {
  const f = await fixture(t);
  const redisEnv = loadServerEnvironment(); assert.ok(redisEnv.REDIS_URL, 'Run npm run redis:setup before integration tests.');
  const redisPrefix = `constellate:test:${randomBytes(8).toString('hex')}`;
  const redis = new RedisConnections(redisEnv.REDIS_URL, redisPrefix); await redis.connect();
  f.cleanup.push(async () => { const keys = await redis.command.keys(`${redisPrefix}:*`); if (keys.length) await redis.command.del(...keys); redis.close(); });
  await migrate(f.pool);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const address = reservation.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let logs = '';
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  };
  f.cleanup.push(stop);
  const start = async () => {
    child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/index.js', import.meta.url))], {
      env: { ...process.env, DATABASE_URL: f.url, REDIS_URL: redisEnv.REDIS_URL, REDIS_KEY_PREFIX: redisPrefix, PORT: String(port), CLIENT_ORIGINS: origin }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', data => { logs += data; });
    child.stderr?.on('data', data => { logs += data; });
    await until(async () => {
      assert.equal(child!.exitCode, null, logs);
      return fetch(`${url}/api/ready`).then(response => response.ok, () => false);
    }, `backend startup: ${logs}`);
  };
  const join = async () => {
    const socket: Client = io(url, { autoConnect: false, forceNew: true, reconnection: false, extraHeaders: { Origin: origin } });
    f.cleanup.push(() => { socket.disconnect(); });
    const states: RoomStatePayload[] = [];
    socket.on('room:state', state => states.push(state));
    socket.connect(); await once(socket, 'connect');
    assert.deepEqual(await socket.timeout(2000).emitWithAck('room:join', { roomId: 'restart-room', user: kei }), { ok: true });
    return { socket, states };
  };
  await start();
  const a = await join();
  await a.socket.timeout(2000).emitWithAck('room:rename', { roomId: 'restart-room', name: 'Tomorrow room' });
  for (const title of ['Review notes', 'Write summary']) await a.socket.timeout(2000).emitWithAck('task:create', { roomId: 'restart-room', title, requestId: randomUUID() });
  const task = a.states.at(-1)!.tasks[0];
  await a.socket.timeout(2000).emitWithAck('task:toggle', { roomId: 'restart-room', taskId: task.id, completed: true });
  const expected = a.states.at(-1)!;
  await stop();
  await start();
  const restored = await join();
  assert.deepEqual(restored.states.at(-1), expected, 'a fresh Node process restores PostgreSQL state, including timestamps and IDs');
  assert.match(logs, /PostgreSQL ready/);
});
