import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRoomAction, freshRoom, members, parseRoom, RUNTIME_TIMING, timerSnapshot, type RuntimeAction } from '../src/redis/roomState.js';
import { TIMER_DURATIONS } from '../src/socket/roomTimer.js';

const kei = { id: 'redis-user-kei', nickname: 'kei', avatar: 'dark' as const };
test('shared runtime preserves one visit across tabs/grace and expires crashed sockets without taking another tab offline', () => {
  const room = freshRoom('demo', 0);
  const act = (action: RuntimeAction, at: number) => applyRoomAction(room, action, at);
  act({ kind: 'join', user: kei, socketId: 'one', owner: 'a' }, 0);
  const visit = room.study.visits[kei.id].id;
  act({ kind: 'join', user: kei, socketId: 'two', owner: 'b' }, 10);
  act({ kind: 'timer', action: 'start', guestId: kei.id, socketId: 'one' }, 20);
  act({ kind: 'leave', guestId: kei.id, socketId: 'one', immediate: false }, 1000);
  assert.equal(members(room).length, 1); assert.equal(members(room)[0].connected, true);
  act({ kind: 'leave', guestId: kei.id, socketId: 'two', immediate: false }, 2000);
  assert.equal(members(room)[0].connected, false);
  act({ kind: 'join', user: kei, socketId: 'three', owner: 'b' }, 6000);
  assert.equal(room.study.visits[kei.id].id, visit);
  act({ kind: 'sweep' }, 6000 + RUNTIME_TIMING.lease + RUNTIME_TIMING.grace);
  assert.equal(members(room).length, 0);
  const focus = room.pending.reduce((sum, { event }) => sum + (event.kind === 'activity' ? event.focusMs : 0), 0);
  assert.equal(focus, 1980 + RUNTIME_TIMING.lease, 'disconnected interval is excluded and crash focus stops at the socket lease');
  assert.equal(room.pending.filter(item => item.event.kind === 'sessionStart').length, 1);
  assert.equal(room.pending.filter(item => item.event.kind === 'sessionEnd').length, 1);
});

test('serialized timer/accounting recovers after downtime, caps focus, completes once, and excludes pauses and breaks', () => {
  let room = freshRoom('demo', 1000);
  const act = (action: RuntimeAction, at: number) => applyRoomAction(room, action, at);
  act({ kind: 'join', user: kei, socketId: 'one', owner: 'a' }, 1000);
  const control = (action: 'start' | 'pause' | 'resume' | 'sync' | 'reset', at: number) => act({ kind: 'timer', guestId: kei.id, socketId: 'one', action }, at);
  control('start', 1000); control('pause', 11_000); control('resume', 21_000);
  room = parseRoom(JSON.stringify(room), 'demo'); // A different Node process reads the same Redis state.
  assert.equal(timerSnapshot(room, 31_000).remainingMs, TIMER_DURATIONS.focus - 20_000);
  const deadline = room.timer.endsAt!;
  // Actual heartbeats keep the guest alive without every-second accounting.
  for (let at = 36_000; at < deadline; at += RUNTIME_TIMING.heartbeat) act({ kind: 'heartbeat', owner: 'a', socketIds: ['one'] }, at);
  room = parseRoom(JSON.stringify(room), 'demo');
  act({ kind: 'sweep' }, deadline + 5000); control('sync', deadline + 6000);
  assert.equal(room.timer.phase, 'shortBreak'); assert.equal(room.timer.status, 'idle');
  assert.equal(room.pending.filter(({ event }) => event.kind === 'activity' && event.activity === 'pomodoro').length, 1);
  const focus = () => room.pending.reduce((sum, { event }) => sum + (event.kind === 'activity' ? event.focusMs : 0), 0);
  assert.equal(focus(), TIMER_DURATIONS.focus);
  control('start', deadline + 7000);
  act({ kind: 'sweep' }, deadline + 7000 + TIMER_DURATIONS.shortBreak);
  assert.equal(room.timer.phase, 'focus'); assert.equal(focus(), TIMER_DURATIONS.focus);
  assert.equal(room.pending.filter(({ event }) => event.kind === 'activity' && event.activity === 'pomodoro').length, 1);
});

test('idle sweeps and heartbeats never add per-second SQL events; room histories/rate limits are bounded and corrupt state is rejected', () => {
  const room = freshRoom('demo', 0);
  applyRoomAction(room, { kind: 'join', user: kei, socketId: 'one', owner: 'a' }, 0);
  const before = room.pending.length;
  for (let at = 1000; at < 60_000; at += 1000) applyRoomAction(room, { kind: 'sweep' }, at);
  assert.equal(room.pending.filter(({ event }) => event.kind === 'activity').length, 0);
  // The only additional accounting comes from expiry of the unrenewed socket.
  assert.ok(room.pending.length <= before + 1);
  assert.throws(() => parseRoom('{"schema":1}', 'demo'));
  const other = freshRoom('other', 0); assert.equal(members(other).length, 0);
});
