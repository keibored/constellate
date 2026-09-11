import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';
import { createAppServer } from '../src/app.js';
import { RoomChat, MAX_MESSAGES_PER_ROOM, CHAT_RATE_WINDOW_MS } from '../src/socket/roomChat.js';
import type { ClientToServerEvents, ServerToClientEvents, MemberPresence, RoomUser } from '../../shared/presence.js';
import type { ChatHistory, ChatMessage, ChatSendPayload } from '../../shared/chat.js';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const kei: RoomUser = { id: 'chat-user-kei', nickname: 'kei', avatar: 'dark' };
const mika: RoomUser = { id: 'chat-user-mika', nickname: 'mika', avatar: 'pink' };
const member: MemberPresence = { userId: kei.id, nickname: kei.nickname, avatar: kei.avatar, status: 'reading', connectedAt: 123 };
const origin = 'http://localhost:5173';

async function until(condition: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (!condition()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await delay(10); }
}

async function fixture(t: TestContext) {
  const server = createAppServer([origin], 100);
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
    const connected = new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    client.connect(); await connected;
    return client;
  };
  const join = (client: Client, user = kei, roomId = 'demo') => client.timeout(2_000).emitWithAck('room:join', { roomId, user });
  const send = (client: Client, content: string, roomId = 'demo') => client.timeout(2_000).emitWithAck('chat:send', { roomId, content });
  return { ...server, url, connect, join, send };
}

test('chat keeps only the latest 100 canonical messages, isolates history and clears on disposal', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const chat = new RoomChat();
  const ids = new Set<string>();
  for (let index = 0; index < 105; index++) {
    t.mock.timers.tick(CHAT_RATE_WINDOW_MS);
    const result = chat.send('demo', member, `message ${index}`);
    assert.ok(result.ok);
    assert.match(result.message.id, /^[0-9a-f-]{36}$/);
    assert.equal(result.message.createdAt, Date.now());
    ids.add(result.message.id);
  }
  assert.equal(ids.size, 105);
  assert.equal(MAX_MESSAGES_PER_ROOM, 100);
  assert.equal(chat.history('demo').length, 100);
  assert.equal(chat.history('demo')[0].content, 'message 5');
  assert.equal(chat.history('demo').at(-1)?.content, 'message 104');
  assert.deepEqual(chat.history('night-owls'), []);
  const snapshot = chat.history('demo');
  snapshot.pop();
  assert.equal(chat.history('demo').length, 100);
  chat.dispose();
  assert.deepEqual(chat.history('demo'), []);
});

test('chat rate limit shares a rolling window across the same user and allows other users/rooms', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const chat = new RoomChat();
  for (let index = 0; index < 5; index++) assert.equal(chat.send('demo', { ...member }, 'hello').ok, true);
  assert.equal(chat.send('demo', { ...member, nickname: 'same user, another tab' }, 'sixth').ok, false);
  assert.equal(chat.send('demo', { ...member, userId: mika.id }, 'another member').ok, true);
  assert.equal(chat.send('night-owls', member, 'another room').ok, true);
  t.mock.timers.tick(2_999);
  assert.equal(chat.send('demo', member, 'too early').ok, false);
  t.mock.timers.tick(1);
  assert.equal(chat.send('demo', member, 'window expired').ok, true);
  assert.equal(chat.history('demo').length, 7, 'rejected messages are never stored');
  chat.dispose();
});

test('chat broadcasts one canonical message to sender, peers and same-user tabs; spoofed metadata is ignored', async t => {
  const f = await fixture(t);
  const a = await f.connect(), b = await f.connect(), tab = await f.connect(), isolated = await f.connect();
  await f.join(a); await f.join(b, mika); await f.join(tab); await f.join(isolated, mika, 'night-owls');
  const messages: ChatMessage[][] = [[], [], [], []];
  [a, b, tab, isolated].forEach((client, index) => client.on('chat:message', message => messages[index].push(message)));
  const before = Date.now();
  const spoofed = { roomId: 'demo', content: '  hello mika  ', id: 'fake-id', userId: mika.id, nickname: 'mika', avatar: 'pink', createdAt: 0 };
  assert.deepEqual(await a.timeout(2_000).emitWithAck('chat:send', spoofed), { ok: true });
  await until(() => messages.slice(0, 3).every(items => items.length === 1), 'first canonical broadcast');
  const canonical = messages[0][0];
  assert.deepEqual(messages[1], messages[0]);
  assert.deepEqual(messages[2], messages[0]);
  assert.equal(canonical.userId, kei.id);
  assert.equal(canonical.nickname, 'kei');
  assert.equal(canonical.avatar, 'dark');
  assert.equal(canonical.content, 'hello mika');
  assert.notEqual(canonical.id, 'fake-id');
  assert.ok(canonical.createdAt >= before && canonical.createdAt <= Date.now());
  await f.send(b, 'lock in 😭');
  await until(() => messages.slice(0, 3).every(items => items.length === 2), 'reverse direction');
  assert.equal(messages[0][1].nickname, 'mika');
  assert.deepEqual(messages[3], []);
  assert.equal(f.presence.list('demo').length, 2);
  assert.deepEqual(f.chat.history('night-owls'), []);
});

test('chat rejects malformed, blank and overlong content; trims and accepts exactly 500 characters', async t => {
  const f = await fixture(t);
  const a = await f.connect(); await f.join(a);
  const malformed: unknown[] = [null, [], '', {}, { roomId: 'demo' }, { roomId: '', content: 'hi' },
    { roomId: '../bad', content: 'hi' }, { roomId: 'x'.repeat(65), content: 'hi' },
    ...[null, [], {}, 123, true, '', '  \n\t ', 'a'.repeat(501)].map(content => ({ roomId: 'demo', content }))];
  for (const payload of malformed) assert.equal((await a.timeout(2_000).emitWithAck('chat:send', payload as ChatSendPayload)).ok, false);
  assert.deepEqual(f.chat.history('demo'), []);
  assert.deepEqual(await f.send(a, ` ${'a'.repeat(500)} `), { ok: true });
  assert.equal(f.chat.history('demo')[0].content.length, 500);
  assert.deepEqual(await f.send(a, '<img src=x onerror=alert(1)>'), { ok: true });
  assert.equal(f.chat.history('demo')[1].content, '<img src=x onerror=alert(1)>', 'content remains plain text');
  a.emit('chat:send', { roomId: 'demo', content: 'raw client' }, {} as (result: unknown) => void);
  await a.timeout(2_000).emitWithAck('timer:sync', { roomId: 'demo' });
  assert.equal(f.chat.history('demo').length, 3);
  assert.deepEqual(await (await fetch(`${f.url}/api/health`)).json(), { status: 'ok' });
});

test('chat requires current socket membership, rejects cross-room sends and cannot disturb timer or status', async t => {
  const f = await fixture(t);
  const a = await f.connect(), outsider = await f.connect(); await f.join(a);
  await a.timeout(2_000).emitWithAck('status:update', { roomId: 'demo', userId: kei.id, status: 'reading' });
  await a.timeout(2_000).emitWithAck('timer:start', { roomId: 'demo' });
  const timer = f.timers.current('demo');
  assert.equal((await f.send(outsider, 'unjoined')).ok, false);
  await f.join(outsider, mika, 'night-owls');
  assert.equal((await f.send(outsider, 'wrong room')).ok, false);
  assert.equal((await f.send(a, 'missing', 'missing-room')).ok, false);
  await f.send(a, 'hello demo');
  assert.deepEqual(f.chat.history('night-owls'), []);
  assert.equal(f.timers.current('demo').endsAt, timer.endsAt);
  assert.equal(f.presence.list('demo')[0].status, 'reading');
  await a.timeout(2_000).emitWithAck('room:leave', { roomId: 'demo' });
  assert.equal((await f.send(a, 'already left')).ok, false);
  await f.join(a);
  f.presence.leave('demo', kei.id, a.id!, true);
  assert.equal((await f.send(a, 'metadata without member')).ok, false);
  assert.equal(f.chat.history('demo').length, 1);
});

test('late joins and reconnects receive authoritative history after grace, separately from another room', async t => {
  const f = await fixture(t);
  const a = await f.connect(); await f.join(a);
  await f.send(a, 'hello'); await f.send(a, 'lock in'); await f.send(a, '😭');
  const history = f.chat.history('demo');
  const late = await f.connect();
  const snapshots: ChatHistory[] = [];
  late.on('chat:history', snapshot => snapshots.push(snapshot));
  await f.join(late, mika);
  assert.deepEqual(snapshots.at(-1), { roomId: 'demo', messages: history });
  await f.join(late, mika, 'night-owls');
  assert.deepEqual(snapshots.at(-1), { roomId: 'night-owls', messages: [] });
  a.disconnect();
  await until(() => !f.presence.list('demo').length, 'last socket removed');
  assert.deepEqual(f.chat.history('demo'), history);
  const returned = await f.connect();
  returned.on('chat:history', snapshot => snapshots.push(snapshot));
  await f.join(returned);
  assert.deepEqual(snapshots.at(-1), { roomId: 'demo', messages: history });
  await f.join(returned);
  assert.equal(new Set(snapshots.at(-1)!.messages.map(message => message.id)).size, 3);
  const fresh = await fixture(t);
  assert.deepEqual(fresh.chat.history('demo'), []);
});

test('rapid sends across same-user tabs accept five messages and reject the rest without disconnecting', async t => {
  const f = await fixture(t);
  const a = await f.connect(), tab = await f.connect(), b = await f.connect();
  await f.join(a); await f.join(tab); await f.join(b, mika);
  const received: ChatMessage[] = [];
  b.on('chat:message', message => received.push(message));
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => f.send(index % 2 ? tab : a, `rapid ${index}`)));
  assert.equal(results.filter(result => result.ok).length, 5);
  assert.equal(results.filter(result => !result.ok).length, 3);
  await until(() => received.length === 5, 'only accepted messages broadcast');
  assert.equal(new Set(received.map(message => message.id)).size, 5);
  assert.ok(a.connected && tab.connected && b.connected);
  assert.equal(f.presence.list('demo').length, 2);
  assert.deepEqual(await f.send(b, 'Mika can still send'), { ok: true });
  assert.deepEqual(await a.timeout(2_000).emitWithAck('timer:start', { roomId: 'demo' }), { ok: true });
  assert.deepEqual(await a.timeout(2_000).emitWithAck('status:update', { roomId: 'demo', userId: kei.id, status: 'break' }), { ok: true });
});
