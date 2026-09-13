import type { TimerStatePayload } from '../../../../shared/timer';

export interface ReceivedTimer {
  state: TimerStatePayload;
  receivedAt: number;
  socketId: string;
}

/** Ignore delayed/duplicate snapshots without moving the local countdown anchor. */
export function receiveTimer(previous: ReceivedTimer | null, state: TimerStatePayload, receivedAt: number, socketId: string): ReceivedTimer {
  if (previous?.socketId === socketId && previous.state.roomId === state.roomId) {
    if (state.revision < previous.state.revision ||
      (state.revision === previous.state.revision && state.serverNow <= previous.state.serverNow)) return previous;
  }
  // A new connection can belong to a restarted server whose revision is zero.
  return { state, receivedAt, socketId };
}

/** Server timestamps plus monotonic elapsed time; the browser's wall clock is irrelevant. */
export function remainingTimerMs(timer: ReceivedTimer | null, now: number): number {
  if (!timer) return 0;
  const { state, receivedAt } = timer;
  if (state.status !== 'running' || state.endsAt === null) return Math.max(0, state.remainingMs);
  const elapsed = Math.max(0, now - receivedAt);
  return Math.max(0, Math.min(state.durationMs, state.endsAt - state.serverNow - elapsed));
}
