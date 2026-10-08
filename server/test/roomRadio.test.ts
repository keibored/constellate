import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { io } from 'socket.io-client';
import { setTimeout as delay } from 'node:timers/promises';
import type { RadioRequest, RadioSnapshot } from '../../shared/radio.js';
import { applyRoomAction, freshRoom, parseRoom, nextRoomDue } from '../src/redis/roomState.js';
import { radioPosition, parseRadioRequest } from '../src/socket/roomRadio.js';
import { receiveRadio, radioElapsed } from '../../client/src/features/radio/radioClock.js';
import { composeSamples } from '../../client/src/features/radio/radioAudio.js';
import { RADIO_TRACKS } from '../../shared/radioCatalog.js';
import { createAppServer } from './helpers/appServer.js';
import { TestRoomRepository } from './helpers/testRoomRepository.js';

const kei = { id: 'radio-kei-user', nickname: 'kei', avatar: 'dark' as const };
const mia = { id: 'radio-mia-user', nickname: 'mia', avatar: 'pink' as const };
function fixture() {
  const room = freshRoom('study', 1000);
  const join = (user = kei, socketId = user.id, at = 1000) => applyRoomAction(room, { kind: 'join', user, socketId, owner: 'node' }, at);
  const command = (request: Omit<RadioRequest, 'roomId'>, user = kei, now = 1000) => applyRoomAction(room, { kind: 'radio', guestId: user.id, socketId: user.id, request: { roomId: 'study', ...request } }, now);
  join(); join(mia);
  return { room, join, command };
}
test('radio rejects non-host controls and unauthorized membership, permits suggestions, and shares rate limits across tabs', () => {
  const f = fixture();
  assert.equal(f.room.radio.hostId, kei.id);
  assert.match(f.command({ command: 'play' }, mia).error!, /host/);
  assert.equal(f.room.radio.playing, false);
  assert.equal(f.command({ command: 'suggest', trackId: 'rain' }, mia).error, undefined);
  assert.equal(f.room.radio.queue[0].nickname, 'mia');
  assert.ok(f.command({ command: 'play' }).radioChanged);
  const stranger = applyRoomAction(f.room, { kind: 'radio', guestId: 'outside', socketId: 'outside', request: { roomId: 'study', command: 'pause' } }, 1010);
  assert.match(stranger.error!, /Rejoin/); assert.equal(f.room.radio.playing, true);
  f.join(mia, 'another-tab');
  for (let i = 0; i < 3; i++) f.command({ command: 'suggest', trackId: 'window-seat' }, mia);
  const tooFast = applyRoomAction(f.room, { kind: 'radio', guestId: mia.id, socketId: 'another-tab', request: { roomId: 'study', command: 'suggest', trackId: 'rain' } }, 1001);
  assert.match(tooFast.error!, /too fast/);
});
test('radio clock preserves paused position, advances the queue on time, and loops without clock drift after downtime', () => {
  const f = fixture();
  f.command({ command: 'play' }, kei, 1000);
  f.command({ command: 'pause' }, kei, 5000);
  assert.equal(radioPosition(f.room.radio, 9000), 4000);
  f.command({ command: 'suggest', trackId: 'rain' }, mia, 9000);
  f.command({ command: 'play' }, kei, 10000);
  // Keep guests alive through the simulated playback deadline.
  for (let at = 20000; at < 105000; at += 10000) applyRoomAction(f.room, { kind: 'heartbeat', owner: 'node', socketIds: [kei.id, mia.id] }, at);
  applyRoomAction(f.room, { kind: 'sweep' }, 105000);
  assert.equal(f.room.radio.trackId, 'rain'); assert.equal(f.room.radio.queue.length, 0);
  assert.equal(radioPosition(f.room.radio, 105000), 3000);
  assert.ok(nextRoomDue(f.room, 105000) <= 198000);
  f.join(kei, kei.id, 400000); f.join(mia, mia.id, 400000);
  f.command({ command: 'play' }, kei, 400000);
  assert.ok(radioPosition(f.room.radio, 400000) < 96000);
  assert.equal(parseRoom(JSON.stringify(f.room), 'study').radio.trackId, 'rain');
});
test('host transfers on final socket disconnect, audio pauses when room empties, and queue survives reconnect', () => {
  const f = fixture(); f.join(kei, 'second-tab'); f.command({ command: 'play' });
  f.command({ command: 'suggest', trackId: 'soft-morning' }, mia);
  applyRoomAction(f.room, { kind: 'leave', guestId: kei.id, socketId: kei.id, immediate: false }, 2000);
  assert.equal(f.room.radio.hostId, kei.id);
  applyRoomAction(f.room, { kind: 'leave', guestId: kei.id, socketId: 'second-tab', immediate: false }, 3000);
  assert.equal(f.room.radio.hostId, mia.id); assert.equal(f.room.radio.playing, true);
  applyRoomAction(f.room, { kind: 'leave', guestId: mia.id, socketId: mia.id, immediate: false }, 4000);
  assert.equal(f.room.radio.hostId, null); assert.equal(f.room.radio.playing, false);
  f.join(mia, mia.id, 5000); assert.equal(f.room.radio.hostId, mia.id);
  assert.equal(f.room.radio.queue.length, 1); assert.equal(f.room.radio.playing, false);
});
test('queue is bounded, malformed requests and corrupt serialized radio are rejected, old rooms upgrade additively', () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) assert.equal(f.command({ command: 'suggest', trackId: 'rain' }, mia, 1000 + i * 3100).error, undefined);
  assert.match(f.command({ command: 'suggest', trackId: 'rain' }, mia, 41000).error!, /full/);
  for (const payload of [null, {}, { roomId: '../secret', command: 'play' }, { roomId: 'study', command: 'select', trackId: 'https://evil.example' }, { roomId: 'study', command: 'remove' }, { roomId: 'study', command: 'malicious' }]) assert.equal(parseRadioRequest(payload), null);
  const old = JSON.parse(JSON.stringify(f.room)); delete old.radio; assert.equal(parseRoom(JSON.stringify(old), 'study').radio.playing, false);
  const bad = JSON.parse(JSON.stringify(f.room)); bad.radio.startedAt = null; bad.radio.playing = true;
  assert.throws(() => parseRoom(JSON.stringify(bad), 'study'), /radio/);
});
test('client radio uses a monotonic server anchor, ignores old revisions, and accepts a new connection epoch', () => {
  const state: RadioSnapshot = { hostId: kei.id, trackId: 'rain', playing: true, positionMs: 1000, startedAt: 1000, queue: [], roomId: 'study', epoch: 'one', revision: 4, serverNow: 4000 };
  const received = receiveRadio(null, state, 50, 'socket');
  assert.equal(radioElapsed(received, 2050), 6000);
  assert.equal(receiveRadio(received, { ...state, revision: 3 }, 100, 'socket'), received);
  assert.equal(receiveRadio(received, state, 100, 'socket'), received);
  assert.equal(receiveRadio(received, { ...state, epoch: 'two', revision: 0 }, 100, 'new').state.epoch, 'two');
  assert.equal(radioElapsed({ ...received, state: { ...state, playing: false, positionMs: 3000 } }, 999999), 3000);
});
test('all original audio loops are finite, non-silent, bounded and deterministic', () => {
  for (const track of RADIO_TRACKS) {
    const samples = composeSamples(track.id), again = composeSamples(track.id);
    assert.equal(samples.length, 32 * 22050); assert.equal(Math.abs(samples[0]), 0); assert.equal(Math.abs(samples.at(-1)!), 0);
    let energy = 0;
    for (let i = 0; i < samples.length; i++) { assert.ok(Number.isFinite(samples[i])); assert.ok(Math.abs(samples[i]) < 1); energy += samples[i] ** 2; }
    assert.ok(energy / samples.length > .00001); assert.deepEqual(samples, again);
  }
});
test('Socket.IO broadcasts shared playback, isolates rooms, rejects outsiders, restores late join and transfers hosting', async t => {
  const server = createAppServer([], new TestRoomRepository(), 50);
  server.httpServer.listen(0, '127.0.0.1'); await once(server.httpServer, 'listening');
  const port = (server.httpServer.address() as { port: number }).port;
  const clients = [0, 1, 2, 3].map(() => io(`http://127.0.0.1:${port}`, { autoConnect: false, reconnection: false }));
  t.after(async () => { clients.forEach(client => client.disconnect()); await new Promise<void>(resolve => server.io.close(() => resolve())); });
  for (const client of clients) { client.connect(); await once(client, 'connect'); }
  const [a, b, c, outside] = clients;
  const states: RadioSnapshot[] = [], isolated: RadioSnapshot[] = [];
  b.on('radio:state', state => states.push(state)); c.on('radio:state', state => isolated.push(state));
  await a.timeout(2000).emitWithAck('room:join', { roomId: 'study', user: kei });
  await b.timeout(2000).emitWithAck('room:join', { roomId: 'study', user: mia });
  await c.timeout(2000).emitWithAck('room:join', { roomId: 'other', user: mia }); isolated.length = 0;
  assert.equal((await outside.timeout(2000).emitWithAck('radio:command', { roomId: 'study', command: 'play' })).ok, false);
  assert.equal((await b.timeout(2000).emitWithAck('radio:command', { roomId: 'study', command: 'play' })).ok, false);
  assert.equal((await a.timeout(2000).emitWithAck('radio:command', { roomId: 'study', command: 'play' })).ok, true);
  assert.equal((await b.timeout(2000).emitWithAck('radio:command', { roomId: 'study', command: 'suggest', trackId: 'rain' })).ok, true);
  await delay(30); assert.equal(states.at(-1)?.playing, true); assert.equal(states.at(-1)?.queue[0].nickname, 'mia'); assert.equal(isolated.length, 0);
  let restored: RadioSnapshot | undefined; outside.on('radio:state', state => { restored = state; });
  await outside.timeout(2000).emitWithAck('room:join', { roomId: 'study', user: { ...kei, id: 'radio-late-user' } });
  assert.equal(restored?.playing, true); assert.equal(restored?.queue.length, 1);
  await a.timeout(2000).emitWithAck('room:leave', { roomId: 'study' }); await delay(30);
  assert.equal(states.at(-1)?.hostId, mia.id);
  assert.equal((await b.timeout(2000).emitWithAck('radio:command', { roomId: 'study', command: 'pause' })).ok, true);
});
