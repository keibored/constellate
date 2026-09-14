import { randomUUID } from 'node:crypto';
import type { MemberPresence } from '../../../shared/presence.js';
import type { TimerTransition } from '../socket/roomTimer.js';
import type { TimerStatePayload } from '../../../shared/timer.js';
import type { StudySessionRepository, StudyWrite } from '../repositories/studySessionRepository.js';
import { databaseErrorCode } from '../db/pool.js';

export const STUDY_CHECKPOINT_MS = 60_000;
interface ActiveSession { id: string; guestId: string; connected: boolean; focusStart: number | null }
interface Gathering { id: string; sessions: Map<string, ActiveSession> }
interface FocusCycle { id: string; participants: Map<string, string> }

/** Event-driven accounting; connection Sets remain owned by RoomPresence. */
export class StudySessionService {
  private rooms = new Map<string, Gathering>();
  private timers = new Map<string, TimerStatePayload>();
  private cycles = new Map<string, FocusCycle>();
  private pending: StudyWrite[] = [];
  private writing?: Promise<void>;
  private interval: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private stopped = false;

  constructor(private repository: StudySessionRepository) {
    this.interval = setInterval(() => { this.checkpoint(); this.persist(); }, STUDY_CHECKPOINT_MS);
    this.interval.unref();
  }

  members(roomId: string, members: MemberPresence[]) {
    if (this.stopped) return;
    const now = Date.now();
    this.advance(roomId, now);
    let room = this.rooms.get(roomId);
    if (!room && members.length) {
      room = { id: randomUUID(), sessions: new Map() };
      this.rooms.set(roomId, room);
      this.pending.push({ kind: 'roomStart', id: room.id, roomId, at: now });
    }
    if (!room) return;
    const guests = new Set(members.map(member => member.userId));
    for (const [guestId, session] of room.sessions) if (!guests.has(guestId)) {
      this.pending.push({ kind: 'sessionEnd', id: session.id, at: now, reason: 'left' });
      room.sessions.delete(guestId);
    }
    for (const member of members) {
      let session = room.sessions.get(member.userId);
      if (!session) {
        session = { id: randomUUID(), guestId: member.userId, connected: member.connected, focusStart: null };
        room.sessions.set(member.userId, session);
        this.pending.push({ kind: 'sessionStart', id: session.id, roomId, roomSessionId: room.id, guestId: member.userId, at: now });
      }
      session.connected = member.connected;
      session.focusStart = member.connected && this.isFocusing(roomId) ? now : null;
    }
    if (!room.sessions.size) {
      this.pending.push({ kind: 'roomEnd', id: room.id, at: now });
      this.rooms.delete(roomId);
    }
    this.checkpointRecords(now, roomId);
    this.persist();
  }

  timer(transition: TimerTransition) {
    if (this.stopped) return;
    const { roomId, previous, state, reason, at } = transition;
    this.advance(roomId, at);
    if (reason === 'complete' && previous.phase === 'focus') {
      const cycle = this.cycles.get(roomId);
      if (cycle) for (const sessionId of cycle.participants.values()) this.pending.push({ kind: 'activity',
        sessionId, activity: 'pomodoro', referenceId: cycle.id, start: at, end: at, focusMs: 0 });
      this.cycles.delete(roomId);
    }
    if (reason === 'reset') this.cycles.delete(roomId);
    if (reason === 'start' && state.phase === 'focus') this.cycles.set(roomId, { id: randomUUID(), participants: new Map() });
    this.timers.set(roomId, state);
    for (const session of this.rooms.get(roomId)?.sessions.values() ?? []) {
      session.focusStart = session.connected && this.isFocusing(roomId) ? at : null;
    }
    this.checkpointRecords(Date.now(), roomId);
    this.persist();
  }

  sessionId(roomId: string, guestId: string) { return this.rooms.get(roomId)?.sessions.get(guestId)?.id; }
  private isFocusing(roomId: string) {
    const timer = this.timers.get(roomId);
    return timer?.phase === 'focus' && timer.status === 'running';
  }
  private advance(roomId: string, now: number) {
    const timer = this.timers.get(roomId);
    if (!timer || !this.isFocusing(roomId)) return;
    const end = Math.min(now, timer.endsAt!);
    for (const session of this.rooms.get(roomId)?.sessions.values() ?? []) {
      if (session.focusStart === null || end <= session.focusStart) continue;
      this.pending.push({ kind: 'activity', sessionId: session.id, activity: 'focus', referenceId: randomUUID(),
        start: session.focusStart, end, focusMs: end - session.focusStart });
      // One guest can leave and begin another visit before a shared cycle ends.
      // Attribute its single completion to their latest contributing session.
      this.cycles.get(roomId)?.participants.set(session.guestId, session.id);
      session.focusStart = end;
    }
  }
  private checkpointRecords(at: number, roomId?: string) {
    const room = roomId ? this.rooms.get(roomId) : undefined;
    const rooms = roomId ? (room ? [room] : []) : [...this.rooms.values()];
    if (rooms.length) this.pending.push({ kind: 'checkpoint', at, roomSessionIds: rooms.map(room => room.id),
      sessionIds: rooms.flatMap(room => [...room.sessions.values()].map(session => session.id)) });
  }
  checkpoint() {
    if (this.stopped) return;
    const now = Date.now();
    for (const roomId of this.rooms.keys()) this.advance(roomId, now);
    this.checkpointRecords(now);
  }
  private persist() { void this.flush().catch(error => console.error(`[study] Checkpoint failed (${databaseErrorCode(error)}); retained for retry.`)); }
  async flush(): Promise<void> {
    // Another waiter may already have moved pending events into a new write.
    // Recheck both the active transaction and queue before allowing a read.
    if (this.writing) { await this.writing; return this.flush(); }
    if (!this.pending.length) return;
    const batch = this.pending.splice(0);
    this.writing = this.repository.write(batch).catch(error => { this.pending.unshift(...batch); throw error; });
    try { await this.writing; } finally { this.writing = undefined; }
    if (this.pending.length) await this.flush();
  }
  close() {
    if (this.closing) return this.closing;
    this.checkpoint();
    this.stopped = true;
    clearInterval(this.interval);
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const session of room.sessions.values()) this.pending.push({ kind: 'sessionEnd', id: session.id, at: now, reason: 'shutdown' });
      this.pending.push({ kind: 'roomEnd', id: room.id, at: now });
    }
    this.rooms.clear();
    this.closing = this.flush();
    return this.closing;
  }
}
