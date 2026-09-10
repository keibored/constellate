import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';
import { createAppServer } from '../src/app.js';
import { DISCONNECT_GRACE_MS, RoomPresence } from '../src/socket/roomPresence.js';
import type { ClientToServerEvents, ServerToClientEvents, RoomJoinPayload, RoomUser, PresenceUpdated, StatusUpdatePayload } from '../../shared/presence.js';
import type { TimerStatePayload, TimerRequest } from '../../shared/timer.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const kei: RoomUser = { id: 'test-user-kei', nickname: 'kei', avatar: 'dark' };
const mika: RoomUser = { id: 'test-user-mika', nickname: 'mika', avatar: 'pink' };
const origin = 'http://localhost:5173';
const graceMs = 150;

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(10);
  }
}

async function fixture(t: TestContext) {
  const server = createAppServer([origin], graceMs);
  server.httpServer.listen(0, '127.0.0.1');
  await once(server.httpServer, 'listening');
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const clients: Client[] = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect());
    await new Promise<void>(resolve => server.io.close(() => resolve()));
  });
  const connect = async () => {
    const client: Client = io(url, { autoConnect: false, forceNew: true, reconnection: false, extraHeaders: { Origin: origin } });
    clients.push(client);
    const connected = new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    client.connect();
    await connected;
    return client;
  };
  const join = (client: Client, user = kei, roomId = 'demo') => client.timeout(2_000).emitWithAck('room:join', { roomId, user });
  return { ...server, url, connect, join };
}

test('health, full list and incremental joins work; repeated joins stay unique', async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.url}/api/health`, { headers: { Origin: origin } });
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(DISCONNECT_GRACE_MS, 4_000);

  const a = await f.connect();
  const lists: string[][] = [], joins: string[] = [];
  a.on('presence:list', event => lists.push(event.members.map(member => member.userId)));
  a.on('presence:joined', event => joins.push(event.member.userId));
  assert.deepEqual(await f.join(a), { ok: true });
  const b = await f.connect();
  const bLists: string[][] = [];
  b.on('presence:list', event => bLists.push(event.members.map(member => member.nickname)));
  await f.join(b, mika);
  await until(() => joins.length === 1, 'mika broadcast');
  assert.deepEqual(lists[0], [kei.id]);
  assert.deepEqual(bLists[0], ['kei', 'mika']);
  await f.join(b, mika);
  assert.equal(f.presence.list('demo').length, 2);
  assert.deepEqual(joins, [mika.id]);
  assert.equal(f.presence.list('demo')[0].status, 'coding');
});

test('room isolation, room changes, and explicit leave affect only the correct room', async t => {
  const f = await fixture(t);
  const a = await f.connect(), b = await f.connect();
  await f.join(a);
  const left: string[] = [], joined: string[] = [];
  a.on('presence:left', event => left.push(event.userId));
  a.on('presence:joined', event => joined.push(event.member.userId));
  await f.join(b, mika, 'stellar-fox-27');
  assert.deepEqual(joined, []);
  assert.equal(f.presence.list('demo').length, 1);
  await f.join(b, mika);
  assert.equal(f.presence.list('stellar-fox-27').length, 0);
  await until(() => joined.length === 1, 'join after room change');
  await b.timeout(2_000).emitWithAck('room:leave', { roomId: 'unrelated' });
  assert.equal(f.presence.list('demo').length, 2);
  await b.timeout(2_000).emitWithAck('room:leave', { roomId: 'demo' });
  await until(() => left.length === 1, 'explicit leave');
  assert.deepEqual(left, [mika.id]);
  assert.equal(f.presence.list('demo').length, 1);
});

test('disconnect retains presence briefly; rejoining cancels removal and keeps connectedAt', async t => {
  const f = await fixture(t);
  const observer = await f.connect();
  await f.join(observer, mika);
  const a = await f.connect();
  await f.join(a);
  const connectedAt = f.presence.list('demo').find(member => member.userId === kei.id)?.connectedAt;
  const left: string[] = [];
  observer.on('presence:left', event => left.push(event.userId));
  a.disconnect();
  assert.equal(f.presence.list('demo').length, 2);
  const refreshed = await f.connect();
  await f.join(refreshed);
  await delay(graceMs + 60);
  assert.equal(f.presence.list('demo').length, 2);
  assert.equal(f.presence.list('demo').find(member => member.userId === kei.id)?.connectedAt, connectedAt);
  assert.deepEqual(left, []);
  refreshed.disconnect();
  await until(() => left.length === 1, 'last connection grace expiry');
  assert.deepEqual(left, [kei.id]);
});

test('the same user stays until their final socket disconnects, with one left event', async t => {
  const f = await fixture(t);
  const observer = await f.connect(), a = await f.connect(), b = await f.connect();
  await f.join(observer, mika);
  await f.join(a);
  await f.join(b);
  assert.equal(f.presence.list('demo').length, 2);
  const left: string[] = [];
  observer.on('presence:left', event => left.push(event.userId));
  a.disconnect();
  await delay(graceMs + 60);
  assert.equal(f.presence.list('demo').length, 2);
  assert.deepEqual(left, []);
  b.disconnect();
  await until(() => left.length === 1, 'last socket leaves');
  assert.deepEqual(left, [kei.id]);
  assert.deepEqual(f.presence.list('demo').map(member => member.userId), [mika.id]);
});

test('an explicit leave also retains other sockets for the same user', async t => {
  const f = await fixture(t);
  const a = await f.connect(), b = await f.connect();
  await f.join(a);
  await f.join(b);
  await a.timeout(2_000).emitWithAck('room:leave', { roomId: 'demo' });
  assert.equal(f.presence.list('demo').length, 1);
  await b.timeout(2_000).emitWithAck('room:leave', { roomId: 'demo' });
  assert.equal(f.presence.list('demo').length, 0);
});

test('malformed joins/leaves and malformed acknowledgements do not crash or mutate presence', async t => {
  const f = await fixture(t);
  const a = await f.connect();
  await f.join(a);
  const payloads: unknown[] = [null, [], {}, '', { roomId: '' }, { roomId: '../bad', user: kei },
    { roomId: 'a'.repeat(65), user: kei }, { roomId: 'demo', user: null },
    { roomId: 'demo', user: { ...kei, nickname: '   ' } },
    { roomId: 'demo', user: { ...kei, nickname: 'a'.repeat(25) } },
    { roomId: 'demo', user: { ...kei, nickname: 'a\nb' } },
    { roomId: 'demo', user: { ...kei, avatar: 'invalid' } },
    { roomId: 'demo', user: { ...kei, id: '' } }];
  for (const payload of payloads) {
    const result = await a.timeout(2_000).emitWithAck('room:join', payload as RoomJoinPayload);
    assert.equal(result.ok, false);
  }
  const leave = await a.timeout(2_000).emitWithAck('room:leave', { roomId: '' });
  assert.equal(leave.ok, false);
  // This intentionally bypasses the event contract to exercise hostile wire input.
  a.emit('room:join', { roomId: 'demo', user: kei }, {} as (result: unknown) => void);
  assert.deepEqual(await f.join(a), { ok: true });
  assert.equal(f.presence.list('demo').length, 1);
  assert.deepEqual(await (await fetch(`${f.url}/api/health`)).json(), { status: 'ok' });
});

test('presence lists all members beyond the three visual desk slots', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) {
    const client = await f.connect();
    await f.join(client, { ...kei, id: `test-user-${index}`, nickname: `friend ${index}` });
  }
  assert.equal(f.presence.list('demo').length, 5);
});

test('unlisted browser origins cannot connect with either transport', async t => {
  const f = await fixture(t);
  for (const transport of ['websocket', 'polling'] as const) {
    const client = io(f.url, { autoConnect: false, reconnection: false, transports: [transport], extraHeaders: { Origin: 'https://unlisted.example' } });
    t.after(() => client.disconnect());
    const error = new Promise<Error>(resolve => client.once('connect_error', resolve));
    client.connect();
    await error;
    assert.equal(client.connected, false);
  }
});

test('all statuses reach the sender, same-user tabs and room peers without changing member fields or socket tracking', async t => {
  const f = await fixture(t);
  const a = await f.connect(), sameUser = await f.connect(), observer = await f.connect(), otherRoom = await f.connect();
  await f.join(a);
  await f.join(sameUser);
  await f.join(observer, mika);
  await f.join(otherRoom, kei, 'another-room');
  const original = { ...f.presence.list('demo').find(member => member.userId === kei.id)! };
  const updates: PresenceUpdated[][] = [[], [], [], []];
  [a, sameUser, observer, otherRoom].forEach((client, index) => client.on('presence:updated', event => updates[index].push(event)));
  for (const status of ['reading', 'break', 'dying', 'coding'] as const) {
    assert.deepEqual(await a.timeout(2_000).emitWithAck('status:update', { roomId: 'demo', userId: kei.id, status }), { ok: true });
    await until(() => updates.slice(0, 3).every(events => events.at(-1)?.member.status === status), `${status} broadcast`);
    for (const events of updates.slice(0, 3)) assert.deepEqual(events.at(-1), { roomId: 'demo', member: { ...original, status } });
    assert.equal(f.presence.list('demo').length, 2);
  }
  assert.deepEqual(updates.map(events => events.length), [4, 4, 4, 0]);
  a.disconnect();
  await delay(graceMs + 60);
  assert.equal(f.presence.list('demo').length, 2);
  assert.deepEqual(await sameUser.timeout(2_000).emitWithAck('status:update', { roomId: 'demo', userId: kei.id, status: 'reading' }), { ok: true });
  assert.deepEqual(f.presence.list('demo').find(member => member.userId === kei.id), { ...original, status: 'reading' });
  sameUser.disconnect();
  await until(() => f.presence.list('demo').length === 1, 'final updated socket leaves');
  assert.equal(f.presence.list('demo')[0].userId, mika.id);
});

test('invalid statuses, unjoined sockets and another user/room are rejected without mutating presence', async t => {
  const f = await fixture(t);
  const a = await f.connect(), b = await f.connect(), unjoined = await f.connect();
  await f.join(a);
  await f.join(b, mika);
  const before = f.presence.list('demo');
  const updates: PresenceUpdated[] = [];
  b.on('presence:updated', event => updates.push(event));
  const valid: StatusUpdatePayload = { roomId: 'demo', userId: kei.id, status: 'reading' };
  const payloads: unknown[] = [null, [], '', {}, { ...valid, status: 'sleeping' }, { ...valid, status: 'Reading' },
    { ...valid, status: null }, { ...valid, status: ['coding'] }, { ...valid, status: 1 }, { roomId: 'demo', userId: kei.id },
    { ...valid, roomId: '../demo' }, { ...valid, roomId: 'x'.repeat(65) }, { ...valid, userId: '' },
    { ...valid, userId: mika.id }, { ...valid, userId: 'not-a-member' }, { ...valid, roomId: 'missing-room' }];
  for (const payload of payloads) {
    assert.equal((await a.timeout(2_000).emitWithAck('status:update', payload as StatusUpdatePayload)).ok, false);
  }
  assert.equal((await unjoined.timeout(2_000).emitWithAck('status:update', valid)).ok, false);
  assert.deepEqual(f.presence.list('demo'), before);
  assert.deepEqual(updates, []);
  await a.timeout(2_000).emitWithAck('room:leave', { roomId: 'demo' });
  assert.equal((await a.timeout(2_000).emitWithAck('status:update', valid)).ok, false);
  await f.join(a, kei, 'another-room');
  assert.equal((await a.timeout(2_000).emitWithAck('status:update', valid)).ok, false);
  // Raw clients with absent or malformed acknowledgement arguments cannot crash the handler.
  a.emit('status:update', { ...valid, roomId: 'another-room' }, {} as (result: unknown) => void);
  assert.deepEqual(await a.timeout(2_000).emitWithAck('status:update', { ...valid, roomId: 'another-room', status: 'dying' }), { ok: true });
  assert.equal(f.presence.list('another-room')[0].status, 'dying');
  assert.equal(f.presence.list('demo')[0].status, 'coding');
  assert.deepEqual(await (await fetch(`${f.url}/api/health`)).json(), { status: 'ok' });
});

test('selected status survives repeated joins, refresh and grace expiry and remains scoped to the room', async t => {
  const f = await fixture(t);
  const a = await f.connect();
  await f.join(a);
  await a.timeout(2_000).emitWithAck('status:update', { roomId: 'demo', userId: kei.id, status: 'break' });
  const original = { ...f.presence.list('demo')[0] };
  await f.join(a);
  assert.deepEqual(f.presence.list('demo'), [original]);
  a.disconnect();
  const refreshed = await f.connect();
  const snapshots: PresenceUpdated['member'][][] = [];
  refreshed.on('presence:list', event => snapshots.push(event.members));
  await f.join(refreshed);
  assert.deepEqual(snapshots.at(-1), [original]);
  await delay(graceMs + 60);
  assert.deepEqual(f.presence.list('demo'), [original]);
  refreshed.disconnect();
  await until(() => !f.presence.list('demo').length, 'grace removes all active presence');
  const returned = await f.connect();
  await f.join(returned);
  assert.equal(f.presence.list('demo')[0].status, 'break');
  await f.join(returned, kei, 'another-room');
  assert.equal(f.presence.list('another-room')[0].status, 'coding');
  await returned.timeout(2_000).emitWithAck('status:update', { roomId: 'another-room', userId: kei.id, status: 'dying' });
  await f.join(returned);
  assert.equal(f.presence.list('demo')[0].status, 'break');
  assert.equal(f.presence.list('demo').length, 1);
  const freshServer = await fixture(t);
  await freshServer.join(await freshServer.connect());
  assert.equal(freshServer.presence.list('demo')[0].status, 'coding');
});

test('status requires an active tracked socket, including during disconnect grace; disposal clears remembered status', () => {
  const presence = new RoomPresence(() => {});
  const original = presence.join('demo', kei, 'socket-a').member;
  assert.equal(presence.updateStatus('missing-room', kei.id, 'socket-a', 'reading'), null);
  assert.equal(presence.updateStatus('demo', mika.id, 'socket-a', 'reading'), null);
  assert.equal(presence.updateStatus('demo', kei.id, 'unassociated-socket', 'reading'), null);
  assert.deepEqual(presence.list('demo'), [original]);
  presence.updateStatus('demo', kei.id, 'socket-a', 'reading');
  presence.leave('demo', kei.id, 'socket-a');
  assert.equal(presence.updateStatus('demo', kei.id, 'socket-a', 'dying'), null);
  assert.equal(presence.list('demo')[0].status, 'reading');
  presence.dispose();
  assert.equal(presence.join('demo', kei, 'socket-b').member.status, 'coding');
  presence.dispose();
});

test('timer controls broadcast to all room members and same-user tabs; concurrent starts do not restart', async t => {
  const f = await fixture(t);
  const a = await f.connect(), b = await f.connect(), sameUser = await f.connect(), isolated = await f.connect();
  const states: TimerStatePayload[][] = [[], [], [], []];
  [a, b, sameUser, isolated].forEach((client, index) => client.on('timer:state', state => states[index].push(state)));
  await f.join(a);
  await f.join(b, mika);
  await f.join(sameUser);
  await f.join(isolated, kei, 'night-owls');
  assert.equal(states[0][0].remainingMs, 1_500_000);
  await Promise.all([a, b].map(client => client.timeout(2_000).emitWithAck('timer:start', { roomId: 'demo' })));
  await until(() => states.slice(0, 3).every(events => events.at(-1)?.status === 'running'), 'shared timer start');
  const started = f.timers.current('demo');
  assert.equal(started.revision, 1);
  for (const events of states.slice(0, 3)) assert.equal(events.at(-1)?.endsAt, started.endsAt);
  assert.equal(states[3].length, 1);
  assert.equal(f.timers.current('night-owls').status, 'idle');
  assert.equal(f.presence.list('demo').length, 2);
  const eventCounts = states.map(events => events.length);
  await delay(1_200);
  assert.deepEqual(states.map(events => events.length), eventCounts, 'no per-second timer broadcasts');
  assert.ok(f.timers.current('demo').remainingMs < started.remainingMs - 1_000);
  await b.timeout(2_000).emitWithAck('timer:pause', { roomId: 'demo' });
  await until(() => states.slice(0, 3).every(events => events.at(-1)?.status === 'paused'), 'shared pause');
  const paused = f.timers.current('demo');
  await delay(100);
  assert.equal(f.timers.current('demo').remainingMs, paused.remainingMs);
  await a.timeout(2_000).emitWithAck('timer:resume', { roomId: 'demo' });
  assert.equal(f.timers.current('demo').revision, 3);
  assert.ok(f.timers.current('demo').endsAt! > started.endsAt!);
  await b.timeout(2_000).emitWithAck('timer:reset', { roomId: 'demo' });
  await until(() => states.slice(0, 3).every(events => events.at(-1)?.revision === 4), 'shared reset');
  assert.equal(f.timers.current('demo').remainingMs, 1_500_000);
  assert.equal(f.timers.current('demo').status, 'idle');
});

test('late joins, reconnects and explicit sync receive current time after every member has left', async t => {
  const f = await fixture(t);
  const a = await f.connect();
  await f.join(a);
  await a.timeout(2_000).emitWithAck('timer:start', { roomId: 'demo' });
  const started = f.timers.current('demo');
  await delay(100);
  const b = await f.connect();
  const received: TimerStatePayload[] = [];
  b.on('timer:state', state => received.push(state));
  await f.join(b, mika);
  assert.equal(received[0].endsAt, started.endsAt);
  assert.ok(received[0].remainingMs < started.remainingMs);
  a.disconnect();
  b.disconnect();
  await until(() => !f.presence.list('demo').length, 'all members leave after grace');
  const returned = await f.connect();
  returned.on('timer:state', state => received.push(state));
  await f.join(returned);
  assert.equal(received.at(-1)?.endsAt, started.endsAt);
  assert.equal(received.at(-1)?.status, 'running');
  assert.equal(received.at(-1)?.revision, 1);
  await returned.timeout(2_000).emitWithAck('timer:sync', { roomId: 'demo' });
  assert.equal(received.at(-1)?.endsAt, started.endsAt);
  const fresh = await fixture(t);
  const newcomer = await fresh.connect();
  await fresh.join(newcomer);
  assert.equal(fresh.timers.current('demo').status, 'idle');
});

test('all timer events reject malformed requests and sockets outside the active room membership', async t => {
  const f = await fixture(t);
  const a = await f.connect(), b = await f.connect(), unjoined = await f.connect();
  await f.join(a);
  await f.join(b, mika, 'night-owls');
  const baseline = f.timers.current('demo');
  const received: TimerStatePayload[] = [];
  a.on('timer:state', state => received.push(state));
  for (const event of ['timer:start', 'timer:pause', 'timer:resume', 'timer:reset', 'timer:sync'] as const) {
    for (const payload of [null, [], {}, '', { roomId: '../bad' }, { roomId: 'x'.repeat(65) }]) {
      assert.equal((await a.timeout(2_000).emitWithAck(event, payload as TimerRequest)).ok, false);
    }
    for (const client of [b, unjoined]) assert.equal((await client.timeout(2_000).emitWithAck(event, { roomId: 'demo' })).ok, false);
    assert.equal((await a.timeout(2_000).emitWithAck(event, { roomId: 'missing-room' })).ok, false);
  }
  assert.equal(f.timers.current('demo').revision, baseline.revision);
  assert.deepEqual(received, []);
  await a.timeout(2_000).emitWithAck('room:leave', { roomId: 'demo' });
  assert.equal((await a.timeout(2_000).emitWithAck('timer:reset', { roomId: 'demo' })).ok, false);
  await f.join(a);
  f.presence.leave('demo', kei.id, a.id!, true);
  assert.equal((await a.timeout(2_000).emitWithAck('timer:start', { roomId: 'demo' })).ok, false, 'metadata alone is insufficient');
  await f.join(a);
  a.emit('timer:start', { roomId: 'demo' }, {} as (result: unknown) => void);
  assert.deepEqual(await a.timeout(2_000).emitWithAck('timer:sync', { roomId: 'demo' }), { ok: true });
  assert.equal(f.timers.current('demo').status, 'running');
  assert.deepEqual(await (await fetch(`${f.url}/api/health`)).json(), { status: 'ok' });
});
