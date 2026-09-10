import type { RoomTimerState, TimerAction, TimerPhase, TimerStatePayload } from '../../../shared/timer.js';

export const TIMER_DURATIONS: Readonly<Record<TimerPhase, number>> = { focus: 25 * 60_000, shortBreak: 5 * 60_000 };

interface TimerEntry {
  state: RoomTimerState;
  completion?: ReturnType<typeof setTimeout>;
}

/** One authoritative clock and, while running, one completion timeout per room. */
export class RoomTimer {
  private rooms = new Map<string, TimerEntry>();

  constructor(private onChanged: (state: TimerStatePayload) => void) {}

  private getOrCreate(roomId: string): TimerEntry {
    let entry = this.rooms.get(roomId);
    if (!entry) {
      entry = { state: {
        phase: 'focus', status: 'idle', durationMs: TIMER_DURATIONS.focus,
        remainingMs: TIMER_DURATIONS.focus, startedAt: null, endsAt: null, revision: 0,
      } };
      this.rooms.set(roomId, entry);
    }
    return entry;
  }

  private snapshot(roomId: string, entry: TimerEntry, now: number): TimerStatePayload {
    const state = entry.state;
    return { ...state, roomId, serverNow: now,
      remainingMs: state.status === 'running' ? Math.max(0, state.endsAt! - now) : state.remainingMs,
    };
  }

  private cancelCompletion(entry: TimerEntry) {
    if (entry.completion !== undefined) clearTimeout(entry.completion);
    entry.completion = undefined;
  }

  private completeIfDue(roomId: string, entry: TimerEntry, now: number) {
    if (entry.state.status !== 'running' || entry.state.endsAt! > now) return;
    this.cancelCompletion(entry);
    const phase = entry.state.phase === 'focus' ? 'shortBreak' : 'focus';
    entry.state = {
      phase, status: 'idle', durationMs: TIMER_DURATIONS[phase], remainingMs: TIMER_DURATIONS[phase],
      startedAt: null, endsAt: null, revision: entry.state.revision + 1,
    };
    this.onChanged(this.snapshot(roomId, entry, now));
  }

  private scheduleCompletion(roomId: string, entry: TimerEntry) {
    this.cancelCompletion(entry);
    const revision = entry.state.revision;
    entry.completion = setTimeout(() => {
      // A cancelled callback must never complete a newer run or a disposed room.
      if (this.rooms.get(roomId) !== entry || entry.state.revision !== revision) return;
      entry.completion = undefined;
      this.completeIfDue(roomId, entry, Date.now());
      // A backwards server-clock adjustment may cause an early timeout.
      if (entry.state.status === 'running') this.scheduleCompletion(roomId, entry);
    }, Math.max(0, entry.state.endsAt! - Date.now()));
    entry.completion.unref();
  }

  current(roomId: string): TimerStatePayload {
    const entry = this.getOrCreate(roomId);
    const now = Date.now();
    // Also settle overdue timers if the event loop has delayed their callback.
    this.completeIfDue(roomId, entry, now);
    return this.snapshot(roomId, entry, now);
  }

  apply(roomId: string, action: TimerAction): { state: TimerStatePayload; changed: boolean } {
    const entry = this.getOrCreate(roomId);
    const now = Date.now();
    this.completeIfDue(roomId, entry, now);
    const state = entry.state;
    if ((action === 'start' && state.status === 'idle') || (action === 'resume' && state.status === 'paused')) {
      entry.state = { ...state, status: 'running', startedAt: now, endsAt: now + state.remainingMs, revision: state.revision + 1 };
      this.scheduleCompletion(roomId, entry);
    } else if (action === 'pause' && state.status === 'running') {
      this.cancelCompletion(entry);
      entry.state = { ...state, status: 'paused', remainingMs: Math.max(0, state.endsAt! - now), startedAt: null, endsAt: null, revision: state.revision + 1 };
    } else if (action === 'reset') {
      this.cancelCompletion(entry);
      entry.state = {
        phase: 'focus', status: 'idle', durationMs: TIMER_DURATIONS.focus, remainingMs: TIMER_DURATIONS.focus,
        startedAt: null, endsAt: null, revision: state.revision + 1,
      };
    } else {
      // Syncs, duplicate controls and inapplicable transitions just return current state.
      return { state: this.snapshot(roomId, entry, now), changed: false };
    }
    const snapshot = this.snapshot(roomId, entry, now);
    this.onChanged(snapshot);
    return { state: snapshot, changed: true };
  }

  dispose() {
    for (const entry of this.rooms.values()) this.cancelCompletion(entry);
    this.rooms.clear();
  }
}
