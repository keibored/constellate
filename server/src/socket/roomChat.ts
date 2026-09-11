import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../../../shared/chat.js';
import type { MemberPresence } from '../../../shared/presence.js';

export const MAX_MESSAGES_PER_ROOM = 100;
export const CHAT_RATE_LIMIT = 5;
export const CHAT_RATE_WINDOW_MS = 3_000;

interface ChatRoom {
  messages: ChatMessage[];
  recentSends: Map<string, number[]>;
}

/** Capped room history and a small per-room/user rate limit, shared across tabs. */
export class RoomChat {
  private rooms = new Map<string, ChatRoom>();

  history(roomId: string): ChatMessage[] {
    return [...(this.rooms.get(roomId)?.messages ?? [])];
  }

  send(roomId: string, sender: MemberPresence, content: string): { ok: true; message: ChatMessage } | { ok: false; error: string } {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { messages: [], recentSends: new Map() };
      this.rooms.set(roomId, room);
    }
    const now = Date.now();
    // Prune expired windows when this room is active; no cleanup interval is needed.
    for (const [userId, times] of room.recentSends) {
      const recent = times.filter(time => time > now - CHAT_RATE_WINDOW_MS);
      if (recent.length) room.recentSends.set(userId, recent);
      else room.recentSends.delete(userId);
    }
    const recent = room.recentSends.get(sender.userId) ?? [];
    if (recent.length >= CHAT_RATE_LIMIT) return { ok: false, error: 'A little too fast. Wait a few seconds before sending again.' };

    const message: ChatMessage = {
      id: randomUUID(), roomId, userId: sender.userId, nickname: sender.nickname,
      avatar: sender.avatar, content, createdAt: now,
    };
    room.recentSends.set(sender.userId, [...recent, now]);
    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) room.messages.shift();
    return { ok: true, message };
  }

  dispose() { this.rooms.clear(); }
}
