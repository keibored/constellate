import type { RoomJoinPayload, StatusUpdatePayload } from '../../../shared/presence.js';
import type { ChatSendPayload } from '../../../shared/chat.js';

const presenceStatuses = new Set(['coding', 'reading', 'writing', 'studying', 'break', 'dying']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

export function readRoomId(payload: unknown): string | null {
  return isRecord(payload) && isRoomId(payload.roomId) ? payload.roomId : null;
}

export function parseJoin(payload: unknown): RoomJoinPayload | null {
  if (!isRecord(payload) || !isRoomId(payload.roomId) || !isRecord(payload.user)) return null;
  const { id, nickname, avatar } = payload.user;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) return null;
  if (typeof nickname !== 'string' || !nickname.trim() || nickname.trim().length > 24 || /[\u0000-\u001f\u007f]/.test(nickname)) return null;
  if (avatar !== 'dark' && avatar !== 'pink' && avatar !== 'green') return null;
  return { roomId: payload.roomId, user: { id, nickname: nickname.trim(), avatar } };
}

export function parseStatusUpdate(payload: unknown): StatusUpdatePayload | null {
  if (!isRecord(payload) || !isRoomId(payload.roomId)) return null;
  const { userId, status } = payload;
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(userId)) return null;
  if (typeof status !== 'string' || !presenceStatuses.has(status)) return null;
  return { roomId: payload.roomId, userId, status: status as StatusUpdatePayload['status'] };
}

export function parseChatSend(payload: unknown): ChatSendPayload | null {
  if (!isRecord(payload) || !isRoomId(payload.roomId) || typeof payload.content !== 'string') return null;
  const content = payload.content.trim();
  if (!content || content.length > 500) return null;
  return { roomId: payload.roomId, content };
}
