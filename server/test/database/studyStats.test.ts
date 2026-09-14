import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { loadServerEnvironment } from '../../src/config.js';
import { createDatabasePool } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrations.js';
import { PostgresStudySessionRepository } from '../../src/repositories/postgresStudySessionRepository.js';
import { PostgresRoomRepository } from '../../src/repositories/postgresRoomRepository.js';
import { StudySessionService } from '../../src/services/studySessionService.js';
import { createAppServer } from '../../src/app.js';
import type { StudyWrite } from '../../src/repositories/studySessionRepository.js';
import type { ClientToServerEvents, ServerToClientEvents } from '../../../shared/presence.js';

async function fixture(t: TestContext) {
  const connection = loadServerEnvironment().TEST_DATABASE_URL;
  assert.ok(connection, 'Configure TEST_DATABASE_URL and start PostgreSQL.');
  const schema = `constellate_test_${randomBytes(8).toString('hex')}`;
  const admin = createDatabasePool(connection);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = createDatabasePool(url.href);
  const repository = new PostgresStudySessionRepository(pool);
  const roomRepository = new PostgresRoomRepository(pool);
  const cleanup: (() => Promise<void> | void)[] = [];
  t.after(async () => {
    try { for (const close of cleanup.reverse()) await close(); }
    finally {
      await repository.release(); await pool.end();
      assert.match(schema, /^constellate_test_[a-f0-9]{16}$/);
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
    }
  });
  await migrate(pool); await roomRepository.load('demo'); await roomRepository.load('other');
  return { repository, roomRepository, pool, cleanup };
}
async function until(fn: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 5000;
  while (!await fn()) { assert.ok(Date.now() < end, label); await delay(20); }
}

test('study activity retries are idempotent; totals split focus at local midnight and history uses bounded cursors', async t => {
  const f = await fixture(t);
  const roomSessionId = randomUUID(), sessionId = randomUUID();
  const at = Date.parse('2026-09-13T15:59:00Z');
  const batch: StudyWrite[] = [
    { kind: 'roomStart', id: roomSessionId, roomId: 'demo', at },
    { kind: 'sessionStart', id: sessionId, roomId: 'demo', roomSessionId, guestId: 'stats-user-kei', at },
    { kind: 'activity', activity: 'focus', sessionId, referenceId: randomUUID(), start: at + 30_000, end: at + 90_000, focusMs: 60_000 },
    { kind: 'activity', activity: 'pomodoro', sessionId, referenceId: randomUUID(), start: at, end: at, focusMs: 0 },
    { kind: 'activity', activity: 'task', sessionId, referenceId: randomUUID(), start: at + 90_000, end: at + 90_000, focusMs: 0 },
    { kind: 'sessionEnd', id: sessionId, at: at + 120_000, reason: 'left' },
    { kind: 'roomEnd', id: roomSessionId, at: at + 120_000 },
  ];
  await f.repository.write(batch); await f.repository.write(batch);
  const personal = await f.repository.personal('stats-user-kei', 'Asia/Manila', at + 120_000);
  assert.deepEqual(personal.today, { focusSeconds: 30, completedPomodoros: 0, completedTasks: 1 });
  assert.deepEqual(personal.overall, { focusSeconds: 60, completedPomodoros: 1, completedTasks: 1, sessions: 1 });
  assert.equal((await f.repository.personal('stats-user-mika', 'UTC')).overall.sessions, 0);
  const secondId = randomUUID(), secondRoomSession = randomUUID();
  await f.repository.write([
    { kind: 'roomStart', id: secondRoomSession, roomId: 'other', at: at + 180_000 },
    { kind: 'sessionStart', id: secondId, roomId: 'other', roomSessionId: secondRoomSession, guestId: 'stats-user-kei', at: at + 180_000 },
  ]);
  const first = await f.repository.history('stats-user-kei', 1);
  assert.equal(first.sessions.length, 1); assert.equal(first.sessions[0].id, secondId); assert.ok(first.nextCursor);
  const second = await f.repository.history('stats-user-kei', 1, JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()));
  assert.equal(second.sessions[0].id, sessionId); assert.equal(second.nextCursor, null);
  assert.equal(second.sessions[0].durationSeconds, 120);
  assert.equal((await f.repository.room('other'))?.focusSeconds, 0);
  const room = await f.repository.room('demo');
  assert.equal(room?.completedPomodoros, 1); assert.equal(room?.lastSession?.durationSeconds, 120);
});

test('stale open sessions close at their durable checkpoint; an ownership lock prevents a live backend being recovered', async t => {
  const f = await fixture(t);
  await f.repository.recover();
  const at = Date.now() - 120_000, sessionId = randomUUID(), roomSessionId = randomUUID();
  await f.repository.write([
    { kind: 'roomStart', id: roomSessionId, roomId: 'demo', at },
    { kind: 'sessionStart', id: sessionId, roomId: 'demo', guestId: 'stats-user-kei', roomSessionId, at },
    { kind: 'activity', activity: 'focus', sessionId, referenceId: randomUUID(), start: at, end: at + 60_000, focusMs: 60_000 },
    { kind: 'checkpoint', sessionIds: [sessionId], roomSessionIds: [roomSessionId], at: at + 60_000 },
  ]);
  const replacement = new PostgresStudySessionRepository(f.pool);
  f.cleanup.push(() => replacement.release());
  await assert.rejects(replacement.recover(), /Another Constellate backend/);
  assert.equal((await f.repository.history('stats-user-kei', 10)).sessions[0].endedAt, null);
  await f.repository.release(); // Simulate losing the old backend's PostgreSQL connection.
  await replacement.recover();
  const saved = (await replacement.history('stats-user-kei', 10)).sessions[0];
  assert.equal(saved.endedAt, at + 60_000); assert.equal(saved.endReason, 'server_restart'); assert.equal(saved.focusSeconds, 60);
  assert.equal((await replacement.room('demo'))?.currentSession, null);
  assert.equal((await replacement.room('demo'))?.lastSession?.durationSeconds, 60);
});

test('real sockets keep one study session through reconnect/tabs, atomically deduplicate tasks, and scope HTTP history to the guest', async t => {
  const f = await fixture(t);
  await f.repository.recover();
  const studies = new StudySessionService(f.repository);
  const app = createAppServer(['http://localhost:5173'], f.roomRepository, 200, { service: studies, repository: f.repository });
  f.cleanup.push(async () => { await new Promise<void>(resolve => app.io.close(() => resolve())); await studies.close(); });
  app.httpServer.listen(0, '127.0.0.1'); await once(app.httpServer, 'listening');
  const address = app.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const connect = async (guestId: string, roomId = 'demo') => {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url, { autoConnect: false, reconnection: false });
    f.cleanup.push(() => { socket.disconnect(); });
    socket.connect(); await once(socket, 'connect');
    assert.deepEqual(await socket.timeout(3000).emitWithAck('room:join', { roomId, user: { id: guestId, nickname: guestId, avatar: 'dark' } }), { ok: true });
    return socket;
  };
  const kei = await connect('stats-user-kei'), mika = await connect('stats-user-mika');
  const keiSession = studies.sessionId('demo', 'stats-user-kei');
  const duplicate = await connect('stats-user-kei');
  kei.disconnect();
  assert.equal(studies.sessionId('demo', 'stats-user-kei'), keiSession);
  duplicate.disconnect();
  const restored = await connect('stats-user-kei');
  assert.equal(studies.sessionId('demo', 'stats-user-kei'), keiSession);
  const access = async (socket: typeof kei) => {
    const grant = await socket.timeout(5000).emitWithAck('stats:access', { roomId: 'demo' }); assert.ok(grant.ok); return grant.token;
  };
  const kt = await access(restored), mt = await access(mika);
  const get = (path: string, token: string) => fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  await restored.timeout(3000).emitWithAck('task:create', { roomId: 'demo', title: 'Count once', requestId: randomUUID() });
  const task = (await f.roomRepository.load('demo')).tasks[0];
  for (const completed of [true, false, true, true]) assert.deepEqual(await mika.timeout(3000).emitWithAck('task:toggle', { roomId: 'demo', taskId: task.id, completed }), { ok: true });
  const km = await (await get('/api/stats/me?guestId=stats-user-mika', kt)).json();
  const mm = await (await get('/api/stats/me', mt)).json();
  assert.equal(km.overall.completedTasks, 0); assert.equal(km.overall.sessions, 1);
  assert.equal(mm.overall.completedTasks, 1);
  const taskTimes = await f.pool.query(`SELECT s.last_checkpoint_at, a.ended_at FROM study_sessions s
    JOIN study_activity a ON a.session_id = s.id WHERE s.guest_id = $1 AND a.kind = 'task'`, ['stats-user-mika']);
  assert.ok(taskTimes.rows[0].last_checkpoint_at >= taskTimes.rows[0].ended_at, 'task completion advances its durable checkpoint');
  await restored.timeout(3000).emitWithAck('task:delete', { roomId: 'demo', taskId: task.id });
  assert.equal((await (await get('/api/stats/me', mt)).json()).overall.completedTasks, 1, 'deleting the task preserves its historical contribution');
  assert.equal((await (await get('/api/rooms/demo/stats', kt)).json()).completedTasks, 1);
  assert.equal((await get('/api/rooms/other/stats', kt)).status, 400);
  assert.equal((await fetch(`${url}/api/stats/me`)).status, 401);
  assert.equal((await get('/api/stats/me', 'a'.repeat(43))).status, 401);
  assert.equal((await get('/api/stats/me?timezone=Invalid/Zone', kt)).status, 400);
  assert.equal((await get('/api/stats/me/sessions?limit=99', kt)).status, 400);
  assert.equal((await get('/api/stats/me/sessions?cursor=bad', kt)).status, 400);
  const history = await get('/api/stats/me/sessions', kt);
  assert.equal(history.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await history.json()).sessions.map((session: { id: string }) => session.id), [keiSession]);
  await restored.timeout(3000).emitWithAck('room:leave', { roomId: 'demo' });
  assert.equal((await get('/api/stats/me', kt)).status, 401);
  await studies.flush();
  assert.ok((await f.repository.history('stats-user-kei', 10)).sessions[0].endedAt);
  const next = await connect('stats-user-kei', 'other');
  assert.notEqual(studies.sessionId('other', 'stats-user-kei'), keiSession);
  assert.equal((await f.repository.room('other'))?.completedTasks, 0);
  next.disconnect(); mika.disconnect();
  await until(() => app.presence.list('demo').length === 0 && app.presence.list('other').length === 0, 'grace expiry');
  await studies.flush();
  assert.ok((await f.repository.history('stats-user-mika', 10)).sessions[0].endedAt);
});
