import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { connectRoom, type ConnectionStatus } from '../../client/src/services/roomConnection.js';
import type { RoomSocket } from '../../client/src/services/socket.js';
import type { RoomResult } from '../../shared/presence.js';

class FakeSocket extends EventEmitter {
  io = new EventEmitter();
  connected = false;
  active = true;
  id = 'socket-a';
  connects = 0;
  disconnects = 0;
  sent: { event: string; payload: unknown; acknowledge: (error: Error | null, result?: RoomResult) => void }[] = [];
  timeout() { return this; }
  override emit(event: string, ...args: unknown[]) {
    if (event === 'room:join' || event === 'room:leave') {
      this.sent.push({ event, payload: args[0], acknowledge: args[1] as typeof this.sent[number]['acknowledge'] });
      return true;
    }
    return super.emit(event, ...args);
  }
  connect() {
    this.connects++;
    this.connected = true;
    this.emit('connect');
    return this;
  }
  disconnect() {
    this.disconnects++;
    this.connected = false;
    this.emit('disconnect', 'io client disconnect');
    return this;
  }
}

function fixture(t: TestContext) {
  const socket = new FakeSocket();
  const connections: ConnectionStatus[] = [];
  const errors: (string | null)[] = [];
  const logs: string[] = [];
  const subscribe = (roomId = 'demo') => connectRoom(socket as unknown as RoomSocket, roomId, { id: 'test-user-kei', nickname: 'kei', avatar: 'dark' }, {
    connection: status => connections.push(status), error: error => errors.push(error), disconnected: () => {}, log: event => logs.push(event),
  });
  const subscription = subscribe();
  t.after(() => subscription.dispose());
  return { socket, connections, errors, logs, subscription, subscribe };
}

test('the client joins once per connection and waits for acknowledgement before reporting connected', t => {
  const f = fixture(t);
  assert.equal(f.socket.sent.length, 1);
  assert.deepEqual(f.socket.sent[0].payload, { roomId: 'demo', user: { id: 'test-user-kei', nickname: 'kei', avatar: 'dark' } });
  assert.equal(f.connections.at(-1), 'connecting');
  f.socket.sent[0].acknowledge(null, { ok: true });
  assert.equal(f.connections.at(-1), 'connected');
  f.socket.disconnect();
  f.socket.io.emit('reconnect_attempt', 1);
  f.socket.connect();
  assert.equal(f.socket.sent.length, 2);
  f.socket.sent[1].acknowledge(null, { ok: true });
  assert.equal(f.connections.at(-1), 'connected');
  for (const event of ['connected', 'disconnected', 'reconnecting', 'joined room']) assert.ok(f.logs.includes(event));
});

test('join acknowledgement timeouts retry three times on one transport, then stop until explicitly retried', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    f.socket.sent[attempt].acknowledge(new Error('timeout'));
    t.mock.timers.tick(5_000);
  }
  assert.equal(f.socket.sent.length, 3);
  assert.equal(f.socket.connects, 1);
  assert.equal(f.socket.disconnects, 0);
  assert.equal(f.connections.at(-1), 'error');
  t.mock.timers.tick(60_000);
  assert.equal(f.socket.sent.length, 3);
  f.subscription.retry();
  f.socket.sent[3].acknowledge(null, { ok: true });
  assert.equal(f.connections.at(-1), 'connected');
});

test('stale acknowledgements and retry callbacks cannot affect a new connection or a disposed subscription', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const old = f.socket.sent[0];
  f.socket.disconnect();
  f.socket.connect();
  old.acknowledge(null, { ok: false, error: 'stale' });
  assert.equal(f.errors.at(-1), null);
  f.socket.sent[1].acknowledge(new Error('timeout'));
  f.subscription.dispose();
  const count = f.socket.sent.length;
  t.mock.timers.tick(60_000);
  old.acknowledge(null, { ok: true });
  assert.equal(f.socket.sent.length, count);
  assert.notEqual(f.connections.at(-1), 'connected');
});

test('cleanup preserves unrelated listeners and a StrictMode remount has exactly one room subscription', t => {
  const f = fixture(t);
  const unrelated = () => {};
  f.socket.on('room:error', unrelated);
  f.subscription.dispose();
  assert.equal(f.socket.listenerCount('connect'), 0);
  assert.equal(f.socket.io.listenerCount('reconnect_attempt'), 0);
  assert.deepEqual(f.socket.listeners('room:error'), [unrelated]);
  const next = f.subscribe('test-room');
  assert.equal(f.socket.listenerCount('connect'), 1);
  assert.equal(f.socket.io.listenerCount('reconnect_attempt'), 1);
  assert.equal(f.socket.sent.filter(item => item.event === 'room:join').length, 2);
  assert.equal(f.socket.sent.filter(item => item.event === 'room:leave').length, 1);
  next.dispose();
  assert.equal(f.socket.listenerCount('connect'), 0);
});

test('rejections and exhausted transport retries show an error without disconnect loops; feature errors preserve presence', t => {
  const f = fixture(t);
  f.socket.sent[0].acknowledge(null, { ok: false, error: 'Invalid room' });
  assert.equal(f.connections.at(-1), 'error');
  assert.equal(f.socket.sent.length, 1);
  f.subscription.retry();
  f.socket.sent[1].acknowledge(null, { ok: true });
  for (const operation of ['chat:send', 'timer:sync', 'status:update']) f.socket.emit('room:error', { operation, message: 'Rejected action' });
  assert.equal(f.connections.at(-1), 'connected');
  f.socket.emit('disconnect', 'io server disconnect');
  assert.equal(f.connections.at(-1), 'error');
  assert.equal(f.socket.connects, 1);
  f.socket.io.emit('reconnect_failed');
  assert.equal(f.connections.at(-1), 'error');
  assert.match(f.errors.at(-1)!, /Cannot reach/);
});
