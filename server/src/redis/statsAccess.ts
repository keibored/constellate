import { randomBytes } from 'node:crypto';
import type { Scope, StatsAccessProvider } from '../services/statsAccess.js';
import type { RedisRoomRuntime } from './roomRuntime.js';
import { parseRoom } from './roomState.js';

/** Cross-node HTTP access. The token is temporary; membership remains authoritative. */
export class RedisStatsAccess implements StatsAccessProvider {
  constructor(private runtime: RedisRoomRuntime) {}
  async grant(socketId: string, roomId: string, guestId: string, previous?: string) {
    const redis = this.runtime.redis; redis.requireReady();
    const token = previous ?? randomBytes(32).toString('base64url');
    await redis.command.set(redis.keys.access(token), JSON.stringify({ token, socketId, roomId, guestId }), 'EX', 900);
    return token;
  }
  async revoke(token?: string) {
    if (!token || !this.runtime.redis.ready) return;
    await this.runtime.redis.command.del(this.runtime.redis.keys.access(token));
  }
  async resolve(token: string): Promise<Scope | undefined> {
    const redis = this.runtime.redis; redis.requireReady();
    const value = await redis.command.get(redis.keys.access(token));
    if (!value) return;
    let scope: Scope;
    try { scope = JSON.parse(value); } catch { return; }
    if (scope.token !== token || typeof scope.roomId !== 'string' || typeof scope.guestId !== 'string' || typeof scope.socketId !== 'string') return;
    const raw = await redis.command.hget(redis.keys.room(scope.roomId), 'state');
    if (!raw) return;
    const room = parseRoom(raw, scope.roomId);
    const guest = Object.prototype.hasOwnProperty.call(room.presence, scope.guestId) ? room.presence[scope.guestId] : undefined;
    const socket = guest && Object.prototype.hasOwnProperty.call(guest.sockets, scope.socketId) ? guest.sockets[scope.socketId] : undefined;
    const time = await redis.command.time();
    if (!socket || socket.expiresAt <= Number(time[0]) * 1000 + Number(time[1]) / 1000) return;
    return scope;
  }
}
