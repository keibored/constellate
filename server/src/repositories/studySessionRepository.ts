export type StudyWrite =
  | { kind: 'roomStart'; id: string; roomId: string; at: number }
  | { kind: 'sessionStart'; id: string; roomId: string; roomSessionId: string; guestId: string; at: number }
  | { kind: 'activity'; sessionId: string; activity: 'focus' | 'pomodoro' | 'task'; referenceId: string; start: number; end: number; focusMs: number }
  | { kind: 'sessionEnd'; id: string; at: number; reason: 'left' | 'shutdown' }
  | { kind: 'roomEnd'; id: string; at: number }
  | { kind: 'checkpoint'; sessionIds: string[]; roomSessionIds: string[]; at: number };
export type StudyActivity = Extract<StudyWrite, { kind: 'activity' }>;
export interface StudySessionRepository { write(events: readonly StudyWrite[]): Promise<void> }
