export type TimerPhase = 'focus' | 'shortBreak';
export type TimerStatus = 'idle' | 'running' | 'paused';
export type TimerAction = 'start' | 'pause' | 'resume' | 'reset' | 'sync';

export interface RoomTimerState {
  phase: TimerPhase;
  status: TimerStatus;
  durationMs: number;
  remainingMs: number;
  startedAt: number | null;
  endsAt: number | null;
  revision: number;
}

export interface TimerStatePayload extends RoomTimerState {
  roomId: string;
  serverNow: number;
}

export interface TimerRequest { roomId: string }
