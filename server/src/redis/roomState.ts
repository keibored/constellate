import { randomUUID } from 'node:crypto';
import type { MemberPresence, PresenceStatus, RoomUser } from '../../../shared/presence.js';
import type { RoomTimerState, TimerAction, TimerStatePayload } from '../../../shared/timer.js';
import type { ChatMessage } from '../../../shared/chat.js';
import type { ReactionKind, RoomReaction } from '../../../shared/reactions.js';
import type { StudyWrite } from '../repositories/studySessionRepository.js';
import { TIMER_DURATIONS } from '../socket/roomTimer.js';

export const RUNTIME_TIMING = { heartbeat: 15_000, lease: 45_000, grace: 15_000, checkpoint: 60_000, idle: 3_600_000, sweep: 5000 };
interface Guest { member: MemberPresence; sockets: Record<string, { owner: string; expiresAt: number }>; graceUntil: number | null }
interface Visit { id: string; focusStart: number | null }
export interface RuntimeRoom {
  schema: 1; epoch: string; revision: number; roomId: string; lastActive: number;
  presence: Record<string, Guest>;
  statuses: Record<string, { status: PresenceStatus; at: number }>;
  timer: RoomTimerState;
  study: { gathering: string | null; visits: Record<string, Visit>; cycle: { id: string; contributors: Record<string, string> } | null; checkpointAt: number };
  pending: { id: string; event: StudyWrite }[];
  messages: ChatMessage[]; reactions: RoomReaction[];
  rates: Record<string, number[]>;
}
export type RuntimeAction =
  | { kind: 'join'; user: RoomUser; socketId: string; owner: string; status?: PresenceStatus }
  | { kind: 'leave'; guestId: string; socketId: string; immediate: boolean }
  | { kind: 'heartbeat'; owner: string; socketIds: string[] }
  | { kind: 'status'; guestId: string; socketId: string; status: PresenceStatus }
  | { kind: 'timer'; guestId: string; socketId: string; action: TimerAction }
  | { kind: 'chat'; guestId: string; socketId: string; content: string }
  | { kind: 'reaction'; guestId: string; socketId: string; reaction: ReactionKind }
  | { kind: 'member'; guestId: string; socketId: string }
  | { kind: 'checkpoint' | 'sweep' };
export interface RuntimeResult { room: RuntimeRoom; now: number; presenceChanged: boolean; timerChanged: boolean; message?: ChatMessage; reaction?: RoomReaction; member?: MemberPresence; error?: string }

const own = <T>(object: Record<string, T>, key: string): T | undefined => Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
const put = <T>(object: Record<string, T>, key: string, value: T) => { Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true }); };
function initialTimer(revision = 0): RoomTimerState {
  return { phase: 'focus', status: 'idle', durationMs: TIMER_DURATIONS.focus, remainingMs: TIMER_DURATIONS.focus, startedAt: null, endsAt: null, revision };
}
function enqueue(room: RuntimeRoom, event: StudyWrite) { room.pending.push({ id: randomUUID(), event }); }
export function freshRoom(roomId: string, now: number): RuntimeRoom {
  const room: RuntimeRoom = { schema: 1, epoch: randomUUID(), revision: 0, roomId, lastActive: now, presence: {}, statuses: {}, timer: initialTimer(),
    study: { gathering: null, visits: {}, cycle: null, checkpointAt: now }, pending: [], messages: [], reactions: [], rates: {} };
  // Redis loss/expiry must not leave the previous generation's SQL visits open.
  enqueue(room, { kind: 'recoverRoom', roomId, generation: room.epoch });
  return room;
}
export function members(room: RuntimeRoom) {
  return Object.values(room.presence).map(guest => guest.member).sort((a, b) => a.connectedAt - b.connectedAt || a.userId.localeCompare(b.userId));
}
export function timerSnapshot(room: RuntimeRoom, now: number): TimerStatePayload {
  return { ...room.timer, roomId: room.roomId, serverNow: now, remainingMs: room.timer.status === 'running' ? Math.max(0, room.timer.endsAt! - now) : room.timer.remainingMs };
}
const focusing = (room: RuntimeRoom) => room.timer.phase === 'focus' && room.timer.status === 'running';
function settleFocus(room: RuntimeRoom, now: number) {
  if (!focusing(room)) return;
  for (const [guestId, visit] of Object.entries(room.study.visits)) {
    const guest = own(room.presence, guestId);
    if (visit.focusStart === null || !guest) continue;
    const leaseEnd = Math.max(0, ...Object.values(guest.sockets).map(socket => socket.expiresAt));
    const end = Math.min(now, room.timer.endsAt!, leaseEnd);
    if (end <= visit.focusStart) continue;
    enqueue(room, { kind: 'activity', activity: 'focus', sessionId: visit.id, referenceId: randomUUID(), start: visit.focusStart, end, focusMs: end - visit.focusStart });
    if (room.study.cycle) put(room.study.cycle.contributors, guestId, visit.id);
    visit.focusStart = end;
  }
}
function anchor(room: RuntimeRoom, now: number) {
  for (const [guestId, visit] of Object.entries(room.study.visits)) visit.focusStart = focusing(room) && own(room.presence, guestId)?.member.connected ? now : null;
}
function checkpoint(room: RuntimeRoom, now: number) {
  settleFocus(room, now);
  if (room.study.gathering) enqueue(room, { kind: 'checkpoint', at: now, roomSessionIds: [room.study.gathering], sessionIds: Object.values(room.study.visits).map(visit => visit.id) });
  room.study.checkpointAt = now;
}
function removeGuest(room: RuntimeRoom, guestId: string, at: number) {
  const visit = own(room.study.visits, guestId);
  if (visit) enqueue(room, { kind: 'sessionEnd', id: visit.id, at, reason: 'left' });
  delete room.study.visits[guestId]; delete room.presence[guestId];
  if (!Object.keys(room.presence).length && room.study.gathering) {
    enqueue(room, { kind: 'roomEnd', id: room.study.gathering, at }); room.study.gathering = null; room.lastActive = at;
  }
}
function seat(room: RuntimeRoom) {
  const occupied = new Set(members(room).map(member => member.deskId));
  for (const member of members(room)) if (member.connected && !member.deskId) {
    const desk = (['desk-1', 'desk-2', 'desk-3'] as const).find(id => !occupied.has(id));
    if (desk) { member.deskId = desk; occupied.add(desk); }
  }
}
export function applyRoomAction(room: RuntimeRoom, action: RuntimeAction, now: number, timing = RUNTIME_TIMING): RuntimeResult {
  const result: RuntimeResult = { room, now, presenceChanged: false, timerChanged: false };
  const expired = Object.values(room.presence).some(guest => Object.values(guest.sockets).some(socket => socket.expiresAt <= now));
  const due = room.timer.status === 'running' && room.timer.endsAt! <= now;
  if (expired || due || (room.study.gathering && now >= room.study.checkpointAt + timing.checkpoint)) settleFocus(room, now);
  for (const [guestId, guest] of Object.entries(room.presence)) {
    const lastLease = Math.max(0, ...Object.values(guest.sockets).map(socket => socket.expiresAt));
    for (const [id, socket] of Object.entries(guest.sockets)) if (socket.expiresAt <= now) delete guest.sockets[id];
    if (!Object.keys(guest.sockets).length && guest.member.connected) {
      guest.member.connected = false; guest.graceUntil = lastLease + timing.grace;
      const visit = own(room.study.visits, guestId); if (visit) visit.focusStart = null;
      result.presenceChanged = true;
    }
    if (guest.graceUntil !== null && guest.graceUntil <= now) {
      removeGuest(room, guestId, guest.graceUntil); result.presenceChanged = true;
    }
  }
  if (due) {
    if (room.timer.phase === 'focus' && room.study.cycle) {
      for (const sessionId of Object.values(room.study.cycle.contributors)) enqueue(room, { kind: 'activity', activity: 'pomodoro', sessionId,
        referenceId: room.study.cycle.id, start: room.timer.endsAt!, end: room.timer.endsAt!, focusMs: 0 });
      room.study.cycle = null;
    }
    const phase = room.timer.phase === 'focus' ? 'shortBreak' : 'focus';
    room.timer = { ...initialTimer(room.timer.revision + 1), phase, durationMs: TIMER_DURATIONS[phase], remainingMs: TIMER_DURATIONS[phase] };
    anchor(room, now); result.timerChanged = true;
  }
  if (action.kind === 'join') {
    settleFocus(room, now);
    let guest = own(room.presence, action.user.id);
    if (!guest) {
      if (!room.study.gathering) {
        room.study.gathering = room.revision === 0 ? room.epoch : randomUUID(); enqueue(room, { kind: 'roomStart', id: room.study.gathering, roomId: room.roomId, at: now });
      }
      const visit = { id: randomUUID(), focusStart: null };
      put(room.study.visits, action.user.id, visit);
      enqueue(room, { kind: 'sessionStart', id: visit.id, roomId: room.roomId, roomSessionId: room.study.gathering, guestId: action.user.id, at: now });
      guest = { member: { userId: action.user.id, nickname: action.user.nickname, avatar: action.user.avatar, status: own(room.statuses, action.user.id)?.status ?? action.status ?? 'coding',
        connectedAt: now, connected: true, deskId: null }, sockets: {}, graceUntil: null };
      put(room.presence, action.user.id, guest);
    }
    guest.member.nickname = action.user.nickname; guest.member.avatar = action.user.avatar; guest.member.connected = true; guest.graceUntil = null;
    put(guest.sockets, action.socketId, { owner: action.owner, expiresAt: now + timing.lease });
    put(room.statuses, action.user.id, { status: guest.member.status, at: now });
    room.lastActive = now; anchor(room, now); result.member = guest.member; result.presenceChanged = true;
  } else if (action.kind === 'leave') {
    const guest = own(room.presence, action.guestId);
    if (guest && own(guest.sockets, action.socketId)) {
      settleFocus(room, now); delete guest.sockets[action.socketId];
      if (!Object.keys(guest.sockets).length) {
        if (action.immediate) removeGuest(room, action.guestId, now);
        else { guest.member.connected = false; guest.graceUntil = now + timing.grace; room.study.visits[action.guestId].focusStart = null; }
        result.presenceChanged = true;
      }
    }
  } else if (action.kind === 'heartbeat') {
    const ids = new Set(action.socketIds);
    for (const guest of Object.values(room.presence)) for (const [id, socket] of Object.entries(guest.sockets)) {
      if (socket.owner === action.owner && ids.has(id)) socket.expiresAt = now + timing.lease;
    }
  } else if ('guestId' in action) {
    const guest = own(room.presence, action.guestId);
    if (!guest || !own(guest.sockets, action.socketId)) result.error = 'Rejoin this room before changing its state.';
    else {
      result.member = guest.member;
      if (action.kind === 'status') {
        guest.member.status = action.status; put(room.statuses, action.guestId, { status: action.status, at: now }); result.presenceChanged = true;
      } else if (action.kind === 'timer' && (!due || action.action === 'reset')) {
        const timer = room.timer;
        if ((action.action === 'start' && timer.status === 'idle') || (action.action === 'resume' && timer.status === 'paused')) {
          settleFocus(room, now);
          if (action.action === 'start' && timer.phase === 'focus') room.study.cycle = { id: randomUUID(), contributors: {} };
          room.timer = { ...timer, status: 'running', startedAt: now, endsAt: now + timer.remainingMs, revision: timer.revision + 1 };
          anchor(room, now); result.timerChanged = true;
        } else if (action.action === 'pause' && timer.status === 'running') {
          settleFocus(room, now);
          room.timer = { ...timer, status: 'paused', remainingMs: Math.max(0, timer.endsAt! - now), startedAt: null, endsAt: null, revision: timer.revision + 1 };
          anchor(room, now); result.timerChanged = true;
        } else if (action.action === 'reset') {
          settleFocus(room, now); room.timer = initialTimer(timer.revision + 1); room.study.cycle = null; anchor(room, now); result.timerChanged = true;
        }
      } else if (action.kind === 'chat' || action.kind === 'reaction') {
        const key = `${action.kind}:${action.guestId}`;
        const recent = (own(room.rates, key) ?? []).filter(at => at > now - 3000);
        if (recent.length >= 5) result.error = 'A little too fast. Wait a few seconds before sending again.';
        else {
          put(room.rates, key, [...recent, now]);
          if (action.kind === 'chat') {
            result.message = { id: randomUUID(), roomId: room.roomId, userId: action.guestId, nickname: guest.member.nickname, avatar: guest.member.avatar, content: action.content, createdAt: now };
            room.messages = [...room.messages, result.message].slice(-100);
          } else {
            result.reaction = { id: randomUUID(), roomId: room.roomId, userId: action.guestId, nickname: guest.member.nickname, kind: action.reaction, createdAt: now };
            room.reactions = [...room.reactions, result.reaction].slice(-3);
          }
        }
      }
    }
  }
  if (result.presenceChanged) seat(room);
  if (result.presenceChanged || result.timerChanged || action.kind === 'checkpoint' || (room.study.gathering && now >= room.study.checkpointAt + timing.checkpoint)) checkpoint(room, now);
  for (const [id, value] of Object.entries(room.statuses)) if (!own(room.presence, id) && value.at < now - timing.idle) delete room.statuses[id];
  for (const [key, values] of Object.entries(room.rates)) if (values.every(at => at <= now - 3000)) delete room.rates[key];
  room.revision++;
  return result;
}
export function nextRoomDue(room: RuntimeRoom, now: number, timing = RUNTIME_TIMING) {
  const deadlines = [room.study.gathering ? room.study.checkpointAt + timing.checkpoint : room.lastActive + timing.idle];
  if (room.pending.length) deadlines.push(now + timing.sweep);
  if (room.timer.status === 'running') deadlines.push(room.timer.endsAt!);
  for (const guest of Object.values(room.presence)) {
    if (guest.graceUntil !== null) deadlines.push(guest.graceUntil);
    for (const socket of Object.values(guest.sockets)) deadlines.push(socket.expiresAt);
  }
  return Math.min(...deadlines);
}

/** Reject corrupt runtime data instead of overwriting pending accounting. */
export function parseRoom(value: string, roomId: string): RuntimeRoom {
  const room = JSON.parse(value) as RuntimeRoom;
  const record = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (room?.schema !== 1 || room.roomId !== roomId || typeof room.epoch !== 'string' || !Number.isSafeInteger(room.revision) || !finite(room.lastActive)
    || !record(room.presence) || !record(room.statuses) || !record(room.study) || !record(room.study.visits)
    || !finite(room.study.checkpointAt) || !Array.isArray(room.pending) || !Array.isArray(room.messages) || room.messages.length > 100
    || !Array.isArray(room.reactions) || room.reactions.length > 3 || !record(room.rates)
    || !['focus', 'shortBreak'].includes(room.timer?.phase) || !['idle', 'running', 'paused'].includes(room.timer?.status)
    || !finite(room.timer.remainingMs) || !finite(room.timer.durationMs) || !Number.isSafeInteger(room.timer.revision)
    || (room.timer.status === 'running' && (!finite(room.timer.endsAt) || !finite(room.timer.startedAt)))) throw new Error('Invalid room runtime schema.');
  for (const [id, guest] of Object.entries(room.presence)) if (!record(guest) || guest.member?.userId !== id || !record(guest.sockets)
    || !finite(guest.member.connectedAt) || typeof guest.member.connected !== 'boolean' || (guest.graceUntil !== null && !finite(guest.graceUntil))
    || Object.values(guest.sockets).some(socket => !record(socket) || typeof socket.owner !== 'string' || !finite(socket.expiresAt))
    || !own(room.study.visits, id)) throw new Error('Invalid room presence.');
  for (const visit of Object.values(room.study.visits)) if (typeof visit.id !== 'string' || (visit.focusStart !== null && !finite(visit.focusStart))) throw new Error('Invalid active study visit.');
  if (room.study.cycle !== null && (typeof room.study.cycle.id !== 'string' || !record(room.study.cycle.contributors))) throw new Error('Invalid timer cycle.');
  for (const item of room.pending) if (typeof item.id !== 'string' || !record(item.event) || typeof item.event.kind !== 'string') throw new Error('Invalid pending study event.');
  return room;
}
