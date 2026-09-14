import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { StudySessionService, STUDY_CHECKPOINT_MS } from '../src/services/studySessionService.js';
import { RoomTimer, TIMER_DURATIONS } from '../src/socket/roomTimer.js';
import type { StudyWrite } from '../src/repositories/studySessionRepository.js';
import type { MemberPresence } from '../../shared/presence.js';

const member = (userId = 'study-user-kei', connected = true): MemberPresence => ({ userId, connected, nickname: 'kei', avatar: 'dark', status: 'coding', deskId: 'desk-1', connectedAt: 1_000_000 });

test('a stats flush waits for queued session ends even when another caller starts their database write', async t => {
  const commits: (() => void)[] = [];
  const saved: StudyWrite[] = [];
  const service = new StudySessionService({ async write(batch) {
    await new Promise<void>(resolve => commits.push(resolve));
    saved.push(...batch);
  } });
  t.after(async () => { commits.forEach(commit => commit()); await service.close(); });
  service.members('demo', [member()]);
  service.members('demo', []);
  let flushed = false;
  const reading = service.flush().then(() => { flushed = true; });
  commits[0]();
  await nextTurn();
  assert.equal(commits.length, 2);
  assert.equal(flushed, false, 'history must wait for the second transaction to commit');
  commits[1]();
  await reading;
  assert.equal(saved.filter(event => event.kind === 'sessionEnd').length, 1);
});
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
  const events: StudyWrite[] = [];
  let writes = 0;
  const repository = { async write(batch: readonly StudyWrite[]) { writes++; events.push(...structuredClone(batch)); } };
  const service = new StudySessionService(repository);
  const timer = new RoomTimer(() => {}, event => service.timer(event));
  t.after(async () => { timer.dispose(); await service.close(); });
  const focus = (sessionId?: string) => events.reduce((sum, event) => sum + (event.kind === 'activity' && event.activity === 'focus' && (!sessionId || event.sessionId === sessionId) ? event.focusMs : 0), 0);
  return { service, timer, events, repository, focus, writes: () => writes, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('study sessions survive refresh/duplicate tabs and brief disconnects; only connected running-focus time counts', async t => {
  const f = fixture(t);
  f.service.members('demo', [member()]); await f.service.flush();
  const id = f.service.sessionId('demo', member().userId);
  f.service.members('demo', [member()]);
  f.timer.apply('demo', 'start'); f.tick(10_000);
  f.service.members('demo', [member(undefined, false)]); f.tick(5_000);
  f.service.members('demo', [member()]);
  assert.equal(f.service.sessionId('demo', member().userId), id);
  f.tick(10_000); f.timer.apply('demo', 'pause'); f.tick(8_000);
  f.timer.apply('demo', 'resume'); f.tick(2_500); f.timer.apply('demo', 'reset');
  f.tick(5_000); f.service.members('demo', []); await f.service.flush();
  assert.equal(f.focus(id), 22_500);
  assert.equal(f.events.filter(event => event.kind === 'sessionStart').length, 1);
  assert.equal(f.events.filter(event => event.kind === 'sessionEnd').length, 1);
  assert.equal(f.events.filter(event => event.kind === 'activity' && event.activity === 'pomodoro').length, 0);
});

test('each contributing session earns one focus completion; late callbacks, breaks and duplicate controls add none', async t => {
  const f = fixture(t);
  const a = member(), b = member('study-user-mika');
  f.service.members('demo', [a]); f.timer.apply('demo', 'start');
  const aId = f.service.sessionId('demo', a.userId)!;
  f.tick(10_000); f.service.members('demo', [a, b]);
  const bId = f.service.sessionId('demo', b.userId)!;
  f.tick(10_000); f.service.members('demo', [b]);
  // Let a read settle an overdue timer before the scheduled callback runs.
  t.mock.timers.setTime(1_000_000 + TIMER_DURATIONS.focus + 5000);
  f.timer.current('demo'); f.timer.apply('demo', 'pause'); f.tick(1);
  await f.service.flush();
  const completions = f.events.filter(event => event.kind === 'activity' && event.activity === 'pomodoro');
  assert.equal(completions.length, 2);
  assert.equal(new Set(completions.map(event => event.kind === 'activity' && event.referenceId)).size, 1, 'one room cycle, shared by both contributors');
  assert.equal(f.focus(aId), 20_000);
  assert.equal(f.focus(bId), TIMER_DURATIONS.focus - 10_000);
  const focused = f.focus();
  f.timer.apply('demo', 'start'); f.tick(TIMER_DURATIONS.shortBreak); await f.service.flush();
  assert.equal(f.focus(), focused);
  assert.equal(f.events.filter(event => event.kind === 'activity' && event.activity === 'pomodoro').length, 2);
});

test('idle zero-focus sessions end normally; room gatherings remain open until the last logical guest leaves', async t => {
  const f = fixture(t);
  const a = member(), b = member('study-user-mika');
  f.service.members('demo', [a]); f.tick(5000); f.service.members('demo', [a, b]);
  f.service.members('elsewhere', [a]); f.timer.apply('elsewhere', 'start'); f.tick(1000);
  f.service.members('demo', [b]); await f.service.flush();
  assert.equal(f.events.filter(event => event.kind === 'roomEnd').length, 0);
  f.service.members('demo', []); await f.service.flush();
  const ids = f.events.filter(event => event.kind === 'sessionStart' && event.roomId === 'demo').map(event => event.kind === 'sessionStart' ? event.id : '');
  assert.equal(ids.length, 2);
  for (const id of ids) assert.equal(f.focus(id), 0);
  assert.equal(f.events.filter(event => event.kind === 'roomEnd').length, 1);
});

test('leaving and starting a new visit during the same focus cycle cannot earn two Pomodoros for one guest', async t => {
  const f = fixture(t);
  f.service.members('demo', [member()]); f.timer.apply('demo', 'start'); f.tick(1000);
  const originalId = f.service.sessionId('demo', member().userId);
  f.service.members('demo', []); f.tick(1000); f.service.members('demo', [member()]);
  const latestId = f.service.sessionId('demo', member().userId);
  assert.notEqual(originalId, latestId);
  t.mock.timers.setTime(1_000_000 + TIMER_DURATIONS.focus);
  f.timer.current('demo'); await f.service.flush();
  const completions = f.events.filter(event => event.kind === 'activity' && event.activity === 'pomodoro');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].kind === 'activity' && completions[0].sessionId, latestId);
});

test('accounting checkpoints run once a minute, never each second, and failed batches retain their event IDs for retry', async t => {
  const f = fixture(t);
  f.service.members('demo', [member()]); f.timer.apply('demo', 'start'); await f.service.flush();
  const before = f.writes(); f.tick(STUDY_CHECKPOINT_MS - 1); await f.service.flush();
  assert.equal(f.writes(), before);
  f.tick(1); await f.service.flush();
  assert.equal(f.focus(), STUDY_CHECKPOINT_MS);
  const original = f.repository.write;
  let failed: readonly StudyWrite[] = [];
  t.mock.method(console, 'error', () => {});
  f.repository.write = async batch => { failed = batch; throw new Error('offline'); };
  f.tick(1500); f.timer.apply('demo', 'pause');
  await assert.rejects(f.service.flush(), /offline/);
  f.repository.write = original;
  await f.service.flush();
  assert.equal(f.focus(), STUDY_CHECKPOINT_MS + 1500);
  const retry = failed.find(event => event.kind === 'activity');
  assert.equal(f.events.filter(event => event.kind === 'activity' && retry?.kind === 'activity' && event.referenceId === retry.referenceId).length, 1);
});
