export interface StudyTotals { focusSeconds: number; completedPomodoros: number; completedTasks: number }
export interface PersonalStats {
  today: StudyTotals; overall: StudyTotals & { sessions: number }; timezone: string; asOf: number;
}
export interface StudySessionRecord extends StudyTotals {
  id: string; roomId: string; roomName: string; startedAt: number; endedAt: number | null;
  durationSeconds: number; endReason: string | null;
}
export interface StudyHistory { sessions: StudySessionRecord[]; nextCursor: string | null }
export interface RoomStudyStats extends StudyTotals {
  roomId: string; roomName: string; asOf: number;
  currentSession: { startedAt: number; durationSeconds: number } | null;
  lastSession: { startedAt: number; endedAt: number; durationSeconds: number } | null;
}
export type StatsAccessResult = { ok: true; token: string } | { ok: false; error: string };
