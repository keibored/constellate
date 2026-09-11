import type { MemberPresence, PresenceStatus, RoomUser } from '../../../shared/presence.js';

interface PresenceEntry {
  member: MemberPresence;
  sockets: Set<string>;
  removal?: ReturnType<typeof setTimeout>;
}

export const DISCONNECT_GRACE_MS = 4_000;

/** Single-process, disposable presence. Socket IDs only count connections. */
export class RoomPresence {
  private rooms = new Map<string, Map<string, PresenceEntry>>();
  // Keep only the last selected status after a member leaves; clear it on shutdown.
  private rememberedStatuses = new Map<string, Map<string, PresenceStatus>>();

  constructor(
    private onRemoved: (roomId: string, userId: string) => void,
    private graceMs = DISCONNECT_GRACE_MS,
  ) {}

  join(roomId: string, user: RoomUser, socketId: string) {
    let room = this.rooms.get(roomId);
    if (!room) { room = new Map(); this.rooms.set(roomId, room); }
    const previous = room.get(user.id);
    if (previous?.removal) clearTimeout(previous.removal);
    const member: MemberPresence = {
      userId: user.id, nickname: user.nickname, avatar: user.avatar,
      status: previous?.member.status ?? this.rememberedStatuses.get(roomId)?.get(user.id) ?? 'coding',
      connectedAt: previous?.member.connectedAt ?? Date.now(),
    };
    const sockets = previous?.sockets ?? new Set<string>();
    sockets.add(socketId);
    room.set(user.id, { member, sockets });
    return {
      member,
      changed: !previous || previous.member.nickname !== member.nickname || previous.member.avatar !== member.avatar,
    };
  }

  list(roomId: string): MemberPresence[] {
    return [...(this.rooms.get(roomId)?.values() ?? [])].map(entry => entry.member)
      .sort((a, b) => a.connectedAt - b.connectedAt || a.userId.localeCompare(b.userId));
  }

  updateStatus(roomId: string, userId: string, socketId: string, status: PresenceStatus): MemberPresence | null {
    const entry = this.rooms.get(roomId)?.get(userId);
    if (!entry || !entry.sockets.has(socketId)) return null;
    entry.member = { ...entry.member, status };
    let statuses = this.rememberedStatuses.get(roomId);
    if (!statuses) { statuses = new Map(); this.rememberedStatuses.set(roomId, statuses); }
    statuses.set(userId, status);
    return entry.member;
  }

  hasSocket(roomId: string, userId: string, socketId: string): boolean {
    return this.rooms.get(roomId)?.get(userId)?.sockets.has(socketId) ?? false;
  }

  memberForSocket(roomId: string, userId: string, socketId: string): MemberPresence | null {
    const entry = this.rooms.get(roomId)?.get(userId);
    return entry?.sockets.has(socketId) ? entry.member : null;
  }

  leave(roomId: string, userId: string, socketId: string, immediate = false) {
    const entry = this.rooms.get(roomId)?.get(userId);
    if (!entry || !entry.sockets.delete(socketId) || entry.sockets.size) return;

    const remove = () => {
      const room = this.rooms.get(roomId);
      // A refresh may have replaced this entry before its grace period elapsed.
      if (room?.get(userId) !== entry || entry.sockets.size) return;
      room.delete(userId);
      if (!room.size) this.rooms.delete(roomId);
      this.onRemoved(roomId, userId);
    };
    if (immediate) remove();
    else entry.removal = setTimeout(remove, this.graceMs);
  }

  dispose() {
    for (const room of this.rooms.values()) {
      for (const entry of room.values()) if (entry.removal) clearTimeout(entry.removal);
    }
    this.rooms.clear();
    this.rememberedStatuses.clear();
  }
}
