import { randomUUID } from 'node:crypto';
import type { RoomRepository } from '../repositories/roomRepository.js';
import { RoomNotFoundError } from '../repositories/roomRepository.js';
import type { PostgresStudySessionRepository } from '../repositories/postgresStudySessionRepository.js';
import { RedisConnections, RuntimeUnavailableError } from './connection.js';
import { applyRoomAction, freshRoom, nextRoomDue, parseRoom, RUNTIME_TIMING, type RuntimeAction, type RuntimeResult, type RuntimeRoom } from './roomState.js';
import type { VoiceTarget } from '../../../shared/voice.js';
import { log } from '../logger.js';

// Compare opaque versions, not just revision numbers (protects against expiry/ABA).
const commit = `
if (redis.call('HGET', KEYS[1], 'version') or '') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'version', ARGV[2], 'state', ARGV[3])
if tonumber(ARGV[5]) > 0 then redis.call('PEXPIRE', KEYS[1], ARGV[5]) else redis.call('PERSIST', KEYS[1]) end
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[6])
return 1`;
const read = `local t = redis.call('TIME'); return {redis.call('HGET', KEYS[1], 'version') or '', redis.call('HGET', KEYS[1], 'state') or '', t[1], t[2]}`;
const remove = `if (redis.call('HGET', KEYS[1], 'version') or '') ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1]); redis.call('ZREM', KEYS[2], ARGV[2]); return 1`;

/** Redis is the only shared runtime truth. Local maps contain this process's socket handles/work only. */
export class RedisRoomRuntime {
  readonly owner = randomUUID();
  private sockets = new Map<string, { roomId: string; guestId: string }>();
  private draining = new Map<string, Promise<void>>();
  private sweeping = false;
  private heartbeating = false;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastErrorLog = 0;
  private closing = false;
  private background = new Set<Promise<void>>();
  onChange?: (result: RuntimeResult, now: number) => void;
  onExpiredSocket?: (socketId: string) => void;
  constructor(readonly redis: RedisConnections, private rooms: RoomRepository, private studies: PostgresStudySessionRepository,
    readonly timing = RUNTIME_TIMING) {}
  start() {
    const track = (work: Promise<void>) => {
      const job = work.catch(error => this.report(error));
      this.background.add(job); void job.finally(() => this.background.delete(job));
    };
    this.sweepTimer = setInterval(() => { track(this.sweep()); }, this.timing.sweep);
    this.heartbeatTimer = setInterval(() => { track(this.heartbeat()); }, this.timing.heartbeat);
    this.sweepTimer.unref(); this.heartbeatTimer.unref();
    track(this.sweep());
  }
  private report(_error: unknown) {
    if (Date.now() - this.lastErrorLog < 30_000) return;
    this.lastErrorLog = Date.now();
    log('error', 'runtime.checkpoint_failed', '[runtime] Shared state/checkpoint unavailable. Pending accounting is retained; check Redis and PostgreSQL.');
  }
  private async load(roomId: string) {
    this.redis.requireReady();
    const values = await this.redis.command.eval(read, 1, this.redis.keys.room(roomId)) as string[];
    const now = Number(values[2]) * 1000 + Math.floor(Number(values[3]) / 1000);
    let room: RuntimeRoom | null = null;
    if (values[1]) {
      try { room = parseRoom(values[1], roomId); }
      catch {
        if (Date.now() - this.lastErrorLog >= 30_000) { this.lastErrorLog = Date.now(); log('error', 'runtime.invalid_state', '[runtime] Invalid room state retained for repair.'); }
        throw new RuntimeUnavailableError();
      }
    }
    return { version: values[0], room, now };
  }
  private async save(version: string, room: RuntimeRoom, now: number) {
    const ttl = room.pending.length ? 0 : Math.max(this.timing.idle, room.timer.status === 'running' ? room.timer.endsAt! - now + this.timing.idle : 0);
    return Number(await this.redis.command.eval(commit, 2, this.redis.keys.room(room.roomId), this.redis.keys.due,
      version, randomUUID(), JSON.stringify(room), nextRoomDue(room, now, this.timing), ttl, room.roomId)) === 1;
  }
  async act(roomId: string, action: RuntimeAction): Promise<RuntimeResult> {
    if (action.kind === 'leave') this.sockets.delete(action.socketId);
    this.redis.requireReady();
    // A deleted PostgreSQL room must never retain/recreate live state.
    try {
      if (this.rooms.exists) { if (!await this.rooms.exists(roomId)) throw new RoomNotFoundError(); }
      else await this.rooms.load(roomId, false);
    }
    catch (error) { if (error instanceof RoomNotFoundError) await this.forget(roomId); throw error; }
    for (let attempt = 0; attempt < 40; attempt++) {
      const loaded = await this.load(roomId);
      if (!loaded.room && action.kind !== 'join') throw new Error('Rejoin this room to restore its live state.');
      const room = loaded.room ?? freshRoom(roomId, loaded.now);
      const result = applyRoomAction(room, action, loaded.now, this.timing);
      if (!await this.save(loaded.version, room, loaded.now)) continue;
      if (action.kind === 'join') this.sockets.set(action.socketId, { roomId, guestId: action.user.id });
      else if (action.kind === 'leave') this.sockets.delete(action.socketId);
      // A periodic snapshot also repairs a missed Pub/Sub update after a node
      // died between its successful Redis commit and its broadcast.
      this.onChange?.(action.kind === 'heartbeat' ? { ...result, presenceChanged: true, timerChanged: true, voiceChanged: true } : result, loaded.now);
      if (room.pending.length) void this.flush(roomId).catch(error => this.report(error));
      return result;
    }
    throw new Error('This room is busy. Please try again.');
  }
  async member(roomId: string, guestId: string, socketId: string) {
    const result = await this.act(roomId, { kind: 'member', guestId, socketId });
    return result.error ? null : result.member ?? null;
  }
  detachSocket(socketId: string) { this.sockets.delete(socketId); }
  async voiceTarget(guestId: string, socketId: string, target: VoiceTarget) {
    const { room, now } = await this.load(target.roomId);
    if (!room || guestId === target.targetGuestId) return null;
    const own = <T>(record: Record<string, T>, key: string) => Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
    const sender = own(room.voice, guestId), receiver = own(room.voice, target.targetGuestId);
    const senderPresence = own(room.presence, guestId), receiverPresence = own(room.presence, target.targetGuestId);
    if (!sender || !receiver || !senderPresence || !receiverPresence || sender.socketId !== socketId || sender.sessionId !== target.sessionId || receiver.sessionId !== target.targetSessionId) return null;
    if ((own(senderPresence.sockets, socketId)?.expiresAt ?? 0) <= now || (own(receiverPresence.sockets, receiver.socketId)?.expiresAt ?? 0) <= now) return null;
    return receiver.socketId;
  }
  async sessionId(roomId: string, guestId: string) { return (await this.load(roomId)).room?.study.visits[guestId]?.id; }
  async checkpoint(roomId: string) { await this.act(roomId, { kind: 'checkpoint' }); await this.flush(roomId); }
  async flush(roomId?: string): Promise<void> {
    if (!roomId) return;
    if (this.draining.has(roomId)) { await this.draining.get(roomId); return this.flush(roomId); }
    const work = this.drain(roomId); this.draining.set(roomId, work);
    try { await work; } finally { this.draining.delete(roomId); }
  }
  private async drain(roomId: string) {
    for (;;) {
      const first = await this.load(roomId);
      const pending = first.room?.pending;
      if (!pending?.length) return;
      await this.studies.write(pending.map(item => item.event), roomId);
      const ids = new Set(pending.map(item => item.id));
      // Remove only committed event IDs; concurrent room changes remain intact.
      for (;;) {
        const current = await this.load(roomId);
        if (!current.room) return;
        current.room.pending = current.room.pending.filter(item => !ids.has(item.id));
        if (await this.save(current.version, current.room, current.now)) break;
      }
    }
  }
  async forget(roomId: string) {
    const current = await this.load(roomId);
    await this.redis.command.eval(remove, 2, this.redis.keys.room(roomId), this.redis.keys.due, current.version, roomId);
  }
  async sweep() {
    if (this.closing || this.sweeping || !this.redis.ready) return;
    this.sweeping = true;
    try {
      const time = await this.redis.command.time(); const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
      const due = await this.redis.command.zrangebyscore(this.redis.keys.due, '-inf', now, 'LIMIT', 0, 50);
      for (const roomId of due) {
        try {
          const current = await this.load(roomId);
          if (!current.room) {
            await this.studies.closeExpiredRuntime(roomId, async () => !await this.redis.command.exists(this.redis.keys.room(roomId)));
            await this.redis.command.eval(remove, 2, this.redis.keys.room(roomId), this.redis.keys.due, current.version, roomId); continue;
          }
          if (!Object.keys(current.room.presence).length && !current.room.pending.length && current.room.timer.status !== 'running' && current.room.lastActive + this.timing.idle <= now) { await this.forget(roomId); continue; }
          await this.act(roomId, { kind: 'sweep' }); await this.flush(roomId);
        } catch (error) { this.report(error); }
      }
    } finally { this.sweeping = false; }
  }
  async heartbeat() {
    if (this.closing || this.heartbeating || !this.redis.ready) return;
    this.heartbeating = true;
    try {
      const rooms = new Map<string, string[]>();
      for (const [socketId, membership] of this.sockets) rooms.set(membership.roomId, [...(rooms.get(membership.roomId) ?? []), socketId]);
      for (const [roomId, socketIds] of rooms) {
        try {
          const result = await this.act(roomId, { kind: 'heartbeat', owner: this.owner, socketIds });
          const known = new Set(Object.values(result.room.presence).flatMap(guest => Object.keys(guest.sockets)));
          for (const socketId of socketIds) if (!known.has(socketId)) { this.sockets.delete(socketId); this.onExpiredSocket?.(socketId); }
        } catch (error) {
          for (const socketId of socketIds) { this.sockets.delete(socketId); this.onExpiredSocket?.(socketId); }
          throw error;
        }
      }
    } finally { this.heartbeating = false; }
  }
  async close() {
    this.closing = true;
    clearInterval(this.sweepTimer); clearInterval(this.heartbeatTimer);
    await Promise.allSettled([...this.background]);
    for (const [socketId, membership] of this.sockets) {
      try { await this.act(membership.roomId, { kind: 'leave', guestId: membership.guestId, socketId, immediate: false }); } catch { /* leases cover dependency failure */ }
    }
    await Promise.allSettled([...this.draining.values()]);
    this.sockets.clear();
  }
}
