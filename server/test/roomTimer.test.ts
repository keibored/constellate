import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { RoomTimer, TIMER_DURATIONS } from '../src/socket/roomTimer.js';
import type { TimerStatePayload } from '../../shared/timer.js';

function clockFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const changes: TimerStatePayload[] = [];
  const timers = new RoomTimer(state => changes.push(state));
  t.after(() => timers.dispose());
  return { timers, changes, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('timer defaults are 25/5 minutes and running snapshots derive fresh remaining time without broadcasts', t => {
  const { timers, changes, tick } = clockFixture(t);
  assert.deepEqual(TIMER_DURATIONS, { focus: 1_500_000, shortBreak: 300_000 });
  const idle = timers.current('demo');
  assert.deepEqual(idle, { roomId: 'demo', phase: 'focus', status: 'idle', durationMs: 1_500_000, remainingMs: 1_500_000, startedAt: null, endsAt: null, revision: 0, serverNow: 1_000_000 });
  const started = timers.apply('demo', 'start').state;
  assert.equal(started.startedAt, 1_000_000);
  assert.equal(started.endsAt, 2_500_000);
  assert.equal(started.revision, 1);
  tick(10_000);
  const current = timers.current('demo');
  assert.equal(current.remainingMs, 1_490_000);
  assert.equal(current.serverNow, 1_010_000);
  assert.equal(current.endsAt, started.endsAt);
  assert.equal(changes.length, 1);
  assert.equal(timers.current('night-owls').status, 'idle');
});

test('pause freezes precise remaining time, resume uses it, and duplicates cannot restart the clock', t => {
  const { timers, changes, tick } = clockFixture(t);
  const started = timers.apply('demo', 'start').state;
  tick(10_250);
  const duplicate = timers.apply('demo', 'start');
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.state.startedAt, started.startedAt);
  assert.equal(duplicate.state.endsAt, started.endsAt);
  assert.equal(duplicate.state.revision, 1);
  const paused = timers.apply('demo', 'pause').state;
  assert.equal(paused.remainingMs, 1_489_750);
  assert.equal(paused.startedAt, null);
  assert.equal(paused.endsAt, null);
  assert.equal(paused.revision, 2);
  tick(5_000);
  assert.equal(timers.current('demo').remainingMs, paused.remainingMs);
  assert.equal(timers.apply('demo', 'pause').changed, false);
  assert.equal(timers.apply('demo', 'start').changed, false);
  const resumed = timers.apply('demo', 'resume').state;
  assert.equal(resumed.endsAt, Date.now() + paused.remainingMs);
  assert.equal(resumed.revision, 3);
  assert.equal(timers.apply('demo', 'resume').changed, false);
  tick(1_000);
  assert.equal(timers.current('demo').remainingMs, paused.remainingMs - 1_000);
  assert.equal(changes.length, 3);
});

test('one completion transitions focus to idle break and break to idle focus, without automatic starts', t => {
  const { timers, changes, tick } = clockFixture(t);
  timers.apply('demo', 'start');
  tick(TIMER_DURATIONS.focus - 1);
  assert.equal(changes.length, 1);
  assert.equal(timers.current('demo').remainingMs, 1);
  tick(1);
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1], { roomId: 'demo', phase: 'shortBreak', status: 'idle', durationMs: 300_000, remainingMs: 300_000, startedAt: null, endsAt: null, revision: 2, serverNow: Date.now() });
  tick(900_000);
  assert.equal(changes.length, 2);
  assert.equal(timers.current('demo').remainingMs, 300_000);
  timers.apply('demo', 'start');
  tick(TIMER_DURATIONS.shortBreak);
  assert.equal(changes.length, 4);
  assert.equal(changes[3].phase, 'focus');
  assert.equal(changes[3].status, 'idle');
  assert.equal(changes[3].remainingMs, 1_500_000);
  assert.equal(changes[3].revision, 4);
  tick(2_000_000);
  assert.equal(changes.length, 4);
});

test('pause, resume and reset cancel old completion callbacks, including after starting a new run', t => {
  const { timers, changes, tick } = clockFixture(t);
  timers.apply('demo', 'start');
  tick(1_000);
  timers.apply('demo', 'pause');
  tick(TIMER_DURATIONS.focus);
  assert.equal(changes.length, 2);
  assert.equal(timers.current('demo').status, 'paused');
  timers.apply('demo', 'resume');
  tick(500);
  const reset = timers.apply('demo', 'reset').state;
  assert.equal(reset.status, 'idle');
  assert.equal(reset.phase, 'focus');
  assert.equal(reset.remainingMs, TIMER_DURATIONS.focus);
  assert.equal(reset.startedAt, null);
  assert.equal(reset.endsAt, null);
  timers.apply('demo', 'start');
  tick(TIMER_DURATIONS.focus - 1);
  assert.equal(changes.length, 5);
  assert.equal(timers.current('demo').phase, 'focus');
  tick(1);
  assert.equal(changes.length, 6);
  assert.equal(changes[5].phase, 'shortBreak');
  timers.apply('demo', 'reset');
  assert.equal(timers.current('demo').remainingMs, TIMER_DURATIONS.focus);
});

test('a sync settles overdue state before a delayed callback and never transitions twice', t => {
  const { timers, changes, tick } = clockFixture(t);
  timers.apply('demo', 'start');
  t.mock.timers.setTime(1_000_000 + TIMER_DURATIONS.focus + 10_000);
  const current = timers.current('demo');
  assert.equal(current.phase, 'shortBreak');
  assert.equal(current.remainingMs, TIMER_DURATIONS.shortBreak);
  tick(1);
  assert.equal(changes.length, 2);
});

test('disposal cancels completion and clears state; invalid transitions and sync do not mutate idle timers', t => {
  const { timers, changes, tick } = clockFixture(t);
  for (const action of ['pause', 'resume', 'sync'] as const) {
    const result = timers.apply('demo', action);
    assert.equal(result.changed, false);
    assert.equal(result.state.revision, 0);
  }
  timers.apply('demo', 'start');
  timers.dispose();
  tick(2_000_000);
  assert.equal(changes.length, 1);
  assert.equal(timers.current('demo').status, 'idle');
  assert.equal(timers.current('demo').revision, 0);
});
