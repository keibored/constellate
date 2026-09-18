import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import type { VoiceParticipants, VoiceSignal } from '../../../shared/voice.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const kei = { id: 'shared-user-kei', nickname: 'kei', avatar: 'dark' as const };
const mika = { id: 'shared-user-mika', nickname: 'mika', avatar: 'pink' as const };
async function until(fn: () => boolean | Promise<boolean>, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!await fn()) { assert.ok(Date.now() < end, label); await delay(20); }
}
async function fixture(t: TestContext, redisUrl?: string) {
  const env = loadServerEnvironment(); assert.ok(env.TEST_DATABASE_URL); assert.ok(env.REDIS_URL, 'Run npm run redis:setup.');
  env.REDIS_URL = redisUrl ?? env.REDIS_URL;
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
    const app = createAppServer(['http://localhost:5173'], rooms, { runtime, repository: studies });
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

test('voice signaling targets only the authorized peer across nodes; another tab cannot take ownership, mute, or signal as it', async t => {
  const f = await fixture(t), a = await f.node(), b = await f.node();
  const one = await f.connect(a.url), two = await f.connect(b.url, mika), tab = await f.connect(b.url), stranger = await f.connect(a.url, { ...mika, id: 'voice-outside-user' }, 'other');
  const received: VoiceSignal[] = [], outside: VoiceSignal[] = [], rosters: VoiceParticipants[] = [];
  two.socket.on('voice:offer', signal => received.push(signal)); stranger.socket.on('voice:offer', signal => outside.push(signal));
  two.socket.on('voice:participants', state => rosters.push(state));
  const firstClient = randomUUID(), secondClient = randomUUID();
  const first = await one.socket.timeout(5000).emitWithAck('voice:join', { roomId: 'demo', clientId: firstClient, muted: false }); assert.ok(first.ok);
  const second = await two.socket.timeout(5000).emitWithAck('voice:join', { roomId: 'demo', clientId: secondClient, muted: false }); assert.ok(second.ok);
  const otherVoice = await stranger.socket.timeout(5000).emitWithAck('voice:join', { roomId: 'other', clientId: randomUUID(), muted: false }); assert.ok(otherVoice.ok);
  const duplicate = await tab.socket.timeout(5000).emitWithAck('voice:join', { roomId: 'demo', clientId: randomUUID(), muted: false });
  assert.equal(duplicate.ok, false); assert.match(!duplicate.ok && duplicate.error || '', /another tab/);
  const signal = { roomId: 'demo', sessionId: first.sessionId, targetGuestId: mika.id, targetSessionId: second.sessionId,
    negotiationId: randomUUID(), description: { type: 'offer' as const, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } };
  assert.deepEqual(await one.socket.timeout(5000).emitWithAck('voice:offer', signal), { ok: true });
  await until(() => received.length === 1, 'targeted signal crosses Redis adapter');
  assert.equal(received[0].fromGuestId, kei.id); assert.equal(received[0].toSessionId, second.sessionId); assert.equal(outside.length, 0);
  assert.equal((await tab.socket.timeout(5000).emitWithAck('voice:offer', signal)).ok, false, 'another same-guest socket cannot signal as the owner');
  assert.equal((await one.socket.timeout(5000).emitWithAck('voice:offer', { ...signal, targetGuestId: 'voice-outside-user', targetSessionId: otherVoice.sessionId })).ok, false);
  assert.equal((await one.socket.timeout(5000).emitWithAck('voice:offer', { ...signal, roomId: 'other' })).ok, false);
  assert.equal((await tab.socket.timeout(5000).emitWithAck('voice:mute-state', { roomId: 'demo', sessionId: first.sessionId, muted: true })).ok, false);
  assert.deepEqual(await one.socket.timeout(5000).emitWithAck('voice:mute-state', { roomId: 'demo', sessionId: first.sessionId, muted: true }), { ok: true });
  await until(() => rosters.at(-1)?.participants.find(participant => participant.guestId === kei.id)?.muted === true, 'mute state reaches peer');
  one.socket.disconnect();
  await until(() => !rosters.at(-1)?.participants.some(participant => participant.guestId === kei.id), 'voice leaves when its owner disconnects');
  assert.equal(tab.presence.at(-1)?.members.length, 2, 'normal room presence remains through the other tab');
  const again = await tab.socket.timeout(5000).emitWithAck('voice:join', { roomId: 'demo', clientId: randomUUID(), muted: false }); assert.ok(again.ok);
  assert.notEqual(again.sessionId, first.sessionId);
  assert.equal((await tab.socket.timeout(5000).emitWithAck('voice:offer', signal)).ok, false, 'old signaling session cannot be replayed');
  await two.socket.timeout(5000).emitWithAck('voice:leave', { roomId: 'demo', clientId: secondClient });
  await until(() => rosters.at(-1)?.participants.length === 1, 'leaving voice updates participants');
  assert.equal(two.socket.connected, true);
  assert.deepEqual(await two.socket.timeout(5000).emitWithAck('chat:send', { roomId: 'demo', content: 'Still studying' }), { ok: true });
});

test('pending accounting survives a failed commit acknowledgement and missing runtime closes stale SQL visits safely', async t => {
  const f = await fixture(t), a = await f.node();
  const originalWrite = f.studies.write.bind(f.studies);
  const mocked = t.mock.method(f.studies, 'write', async () => { throw new Error('simulated database outage'); });
  const one = await f.connect(a.url);
  await one.socket.timeout(5000).emitWithAck('timer:start', { roomId: 'demo' });
  await delay(30);
  await one.socket.timeout(5000).emitWithAck('timer:pause', { roomId: 'demo' });
  await assert.rejects(a.runtime.flush('demo'));
  const key = f.control.keys.room('demo');
  assert.equal(await f.control.command.pttl(key), -1, 'uncommitted accounting cannot expire');
  const state = parseRoom((await f.control.command.hget(key, 'state'))!, 'demo');
  await originalWrite(state.pending.map(item => item.event), 'demo'); // SQL commit succeeded; Redis acknowledgement did not.
  const expected = (await f.studies.personal(kei.id, 'UTC')).overall;
  assert.ok(expected.focusSeconds > 0); assert.equal(expected.sessions, 1);
  mocked.mock.restore();
  await a.runtime.flush('demo');
  assert.deepEqual((await f.studies.personal(kei.id, 'UTC')).overall, expected);
  assert.equal((await f.studies.history(kei.id, 10)).sessions[0].endedAt, null, 'replayed recovery event does not close the current visit');
  assert.ok(await f.control.command.pttl(key) > 0);
  await f.control.command.del(key); await f.control.command.zadd(f.control.keys.due, 0, 'demo');
  await a.runtime.sweep();
  assert.ok((await f.studies.history(kei.id, 10)).sessions[0].endedAt);
});

test('a canceled slow voice join cannot resurrect ownership after voice leave', async t => {
  const f = await fixture(t), a = await f.node(), one = await f.connect(a.url);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = a.runtime.act.bind(a.runtime);
  t.mock.method(a.runtime, 'act', async (...args: Parameters<typeof original>) => {
    if (args[1].kind === 'voiceJoin') { entered(); await gate; }
    return original(...args);
  });
  const clientId = randomUUID();
  const joining = one.socket.timeout(5000).emitWithAck('voice:join', { roomId: 'demo', clientId, muted: false });
  await started;
  const leaving = one.socket.timeout(5000).emitWithAck('voice:leave', { roomId: 'demo', clientId });
  await delay(50); release();
  assert.ok((await joining).ok); assert.ok((await leaving).ok);
  const room = parseRoom((await f.control.command.hget(f.control.keys.room('demo'), 'state'))!, 'demo');
  assert.deepEqual(room.voice, {}); assert.equal(Object.keys(room.presence).length, 1);
});

test('an owned Redis service stop/restart fails closed and restores adapter subscriptions and room state', async t => {
  const binary = process.env.TEST_REDIS_SERVER ?? fileURLToPath(new URL('../../.local/redis/Redis-8.10.1-Windows-x64-cygwin/redis-server.exe', import.meta.url));
  if (!existsSync(binary)) { t.skip('Set TEST_REDIS_SERVER to a Redis executable, or run redis:setup on Windows.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'constellate-redis-test-'));
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const redisUrl = `redis://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  const start = async () => {
    child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--protected-mode', 'yes', '--save', '', '--dir', '.', '--dbfilename', 'test.rdb'],
      { cwd: directory, windowsHide: true, stdio: 'ignore' });
    await until(async () => {
      assert.equal(child!.exitCode, null, 'owned Redis process should stay running');
      const probe = new RedisConnections(redisUrl, 'constellate:probe');
      try { await probe.connect(); return true; } catch { return false; } finally { probe.close(); }
    }, 'owned Redis starts');
  };
  try {
    await start();
    await t.test('both nodes recover without duplicate guests or reset deadlines', async inner => {
      const f = await fixture(inner, redisUrl), a = await f.node(), b = await f.node();
      const one = await f.connect(a.url), two = await f.connect(b.url, mika);
      await one.socket.timeout(5000).emitWithAck('timer:start', { roomId: 'demo' });
      const deadline = one.timers.at(-1)!.endsAt;
      await a.runtime.flush('demo');
      const stopped = once(child!, 'exit');
      await f.control.command.shutdown('SAVE').catch(() => {}); await stopped;
      await until(() => !a.redis.ready && !b.redis.ready && !one.socket.connected && !two.socket.connected, 'all dependency connections close');
      assert.equal((await fetch(`${a.url}/api/ready`)).status, 503);
      assert.equal((await fetch(`${b.url}/api/ready`)).status, 503);
      const health = await fetch(`${a.url}/api/health`);
      assert.equal(health.status, 503);
      assert.deepEqual(await health.json(), { status: 'unavailable', server: 'ok', database: 'ok', redis: 'unavailable' });
      await assert.rejects(a.runtime.act('demo', { kind: 'sweep' }));
      await start();
      await until(() => a.redis.ready && b.redis.ready && f.control.ready, 'all Redis clients reconnect', 15000);
      const restored = await f.connect(a.url), peer = await f.connect(b.url, mika);
      assert.equal(restored.timers.at(-1)?.endsAt, deadline);
      await until(() => restored.presence.at(-1)?.members.length === 2, 'two guests after Redis restart');
      await restored.socket.timeout(5000).emitWithAck('reaction:send', { roomId: 'demo', kind: 'heart' });
      await until(() => peer.reactions.length === 1, 'restored cross-node Pub/Sub subscriptions');
      assert.equal((await fetch(`${a.url}/api/ready`)).status, 200);
      assert.equal((await f.studies.personal(kei.id, 'UTC')).overall.sessions, 1);
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    const target = resolve(directory), expectedParent = resolve(tmpdir());
    assert.ok(target.startsWith(`${expectedParent}\\constellate-redis-test-`) || target.startsWith(`${expectedParent}/constellate-redis-test-`));
    await rm(target, { recursive: true, force: true });
  }
});
