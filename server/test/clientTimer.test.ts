import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiveTimer, remainingTimerMs } from '../../client/src/features/timer/timerClock.js';
import type { TimerStatePayload } from '../../shared/timer.js';

const running: TimerStatePayload = {
  roomId: 'demo', phase: 'focus', status: 'running', durationMs: 1_500_000,
  remainingMs: 1_200_000, startedAt: 1_000_000, endsAt: 2_500_000,
  serverNow: 1_300_000, revision: 1,
};

test('different browser clock origins show the same server countdown, even after skipped render ticks', () => {
  const a = receiveTimer(null, running, 100, 'a');
  const b = receiveTimer(null, running, 900_000, 'b');
  assert.equal(remainingTimerMs(a, 100), 1_200_000, 'a late join starts at 20:00, not 25:00');
  assert.equal(remainingTimerMs(a, 10_100), remainingTimerMs(b, 910_000));
  assert.equal(remainingTimerMs(a, 300_100), 900_000, 'a throttled tab catches up from elapsed time');
  assert.equal(remainingTimerMs(a, 2_000_000), 0);
  assert.equal(a.state.status, 'running', 'the client cannot complete or switch phases itself');
});

test('paused and idle snapshots stay frozen, and a server deadline is preferred over stale remainingMs', () => {
  const paused = receiveTimer(null, { ...running, status: 'paused', startedAt: null, endsAt: null }, 100, 'a');
  assert.equal(remainingTimerMs(paused, 2_000_000), 1_200_000);
  const idle = receiveTimer(null, { ...paused.state, status: 'idle', remainingMs: 1_500_000 }, 100, 'a');
  assert.equal(remainingTimerMs(idle, 2_000_000), 1_500_000);
  const deadline = receiveTimer(null, { ...running, remainingMs: 1_500_000 }, 100, 'a');
  assert.equal(remainingTimerMs(deadline, 100), 1_200_000);
  assert.equal(remainingTimerMs(null, 100), 0);
});

test('duplicate and stale snapshots cannot rewind a countdown; newer syncs and reset revisions are accepted', () => {
  const first = receiveTimer(null, running, 100, 'a');
  assert.equal(receiveTimer(first, { ...running }, 5_000, 'a'), first);
  assert.equal(receiveTimer(first, { ...running, serverNow: running.serverNow - 1_000 }, 5_000, 'a'), first);
  assert.equal(receiveTimer(first, { ...running, revision: 0, serverNow: running.serverNow + 1_000 }, 5_000, 'a'), first);
  const synced = receiveTimer(first, { ...running, serverNow: running.serverNow + 5_000 }, 5_100, 'a');
  assert.notEqual(synced, first);
  assert.equal(remainingTimerMs(synced, 5_100), remainingTimerMs(first, 5_100));
  const reset = receiveTimer(synced, { ...running, revision: 2, status: 'idle', remainingMs: 1_500_000, endsAt: null }, 5_100, 'a');
  assert.equal(remainingTimerMs(reset, 5_100), 1_500_000);
});

test('reconnect/server restart and room changes accept fresh state with a lower revision', () => {
  const old = receiveTimer(null, { ...running, revision: 20 }, 100, 'a');
  const restarted = { ...running, status: 'idle' as const, remainingMs: 1_500_000, endsAt: null, revision: 0 };
  assert.equal(receiveTimer(old, restarted, 1_000, 'new-socket').state.revision, 0);
  assert.equal(receiveTimer(old, { ...restarted, roomId: 'other-room' }, 1_000, 'a').state.roomId, 'other-room');
});
