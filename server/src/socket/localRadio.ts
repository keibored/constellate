import { randomUUID } from 'node:crypto';
import type { MemberPresence } from '../../../shared/presence.js';
import type { RadioRequest, RadioSnapshot } from '../../../shared/radio.js';
import { freshRadio, reconcileRadio, changeRadio, radioSnapshot } from './roomRadio.js';

// The single-process test fixture follows the same rules as the production Redis reducer.
export class LocalRadio {
  private rooms = new Map<string, { state: ReturnType<typeof freshRadio>; epoch: string; revision: number; rates: Map<string, number[]> }>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private members: (roomId: string) => MemberPresence[], private broadcast: (state: RadioSnapshot) => void) {
    this.timer = setInterval(() => { for (const roomId of this.rooms.keys()) this.reconcile(roomId); }, 1000);
    this.timer.unref();
  }
  private room(roomId: string) {
    let room = this.rooms.get(roomId);
    if (!room) { room = { state: freshRadio(), epoch: randomUUID(), revision: 0, rates: new Map() }; this.rooms.set(roomId, room); }
    return room;
  }
  reconcile(roomId: string) {
    const room = this.room(roomId), now = Date.now();
    if (reconcileRadio(room.state, this.members(roomId), now)) {
      room.revision++; this.broadcast(radioSnapshot(room.state, roomId, room.epoch, room.revision, now));
    }
    if (!this.members(roomId).length) this.rooms.delete(roomId);
  }
  snapshot(roomId: string) {
    const room = this.room(roomId);
    return radioSnapshot(room.state, roomId, room.epoch, room.revision, Date.now());
  }
  command(request: RadioRequest, member: MemberPresence): string | null {
    this.reconcile(request.roomId);
    const room = this.room(request.roomId), now = Date.now();
    const recent = (room.rates.get(member.userId) ?? []).filter(at => at > now - 3000);
    if (request.command !== 'sync') {
      if (recent.length >= 5) return 'A little too fast. Wait a few seconds before changing the radio.';
      room.rates.set(member.userId, [...recent, now]);
    }
    const error = changeRadio(room.state, request, member, now);
    if (!error && request.command !== 'sync') { room.revision++; this.broadcast(this.snapshot(request.roomId)); }
    return error;
  }
  dispose() { clearInterval(this.timer); this.rooms.clear(); }
}
