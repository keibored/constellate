import type { PresenceStatus } from '../../../../shared/presence';
import { guestStorage } from '../../services/localStorage';

export const LAST_ROOM_STORAGE_KEY = 'constellate_last_room';
export const STATUS_STORAGE_KEY = 'constellate.room_statuses';
export const isRoomId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
const isStatus = (value: unknown): value is PresenceStatus => typeof value === 'string' && ['coding', 'reading', 'writing', 'studying', 'break', 'dying'].includes(value);

export function getLastRoom(): string | null {
  const value = guestStorage.get(LAST_ROOM_STORAGE_KEY);
  if (isRoomId(value)) return value;
  guestStorage.remove(LAST_ROOM_STORAGE_KEY);
  return null;
}
export function rememberRoom(roomId: string) {
  if (isRoomId(roomId)) guestStorage.set(LAST_ROOM_STORAGE_KEY, roomId);
}
export function forgetRoom(roomId: string) {
  // Leaving an older tab must not clear a different tab's newly joined room.
  if (getLastRoom() === roomId) guestStorage.remove(LAST_ROOM_STORAGE_KEY);
}

function readStatuses(userId: string): Record<string, PresenceStatus> {
  try {
    const saved = JSON.parse(guestStorage.get(STATUS_STORAGE_KEY) ?? 'null');
    if (saved?.userId !== userId || !saved.rooms || typeof saved.rooms !== 'object' || Array.isArray(saved.rooms)) return {};
    return Object.fromEntries(Object.entries(saved.rooms).filter(([roomId, status]) => isRoomId(roomId) && isStatus(status))) as Record<string, PresenceStatus>;
  } catch { return {}; }
}
export function getRoomStatus(userId: string, roomId: string): PresenceStatus {
  const rooms = readStatuses(userId);
  return Object.prototype.hasOwnProperty.call(rooms, roomId) ? rooms[roomId] : 'coding';
}
export function rememberStatus(userId: string, roomId: string, status: PresenceStatus) {
  if (!isRoomId(roomId) || !isStatus(status)) return;
  const rooms = readStatuses(userId);
  if (Object.prototype.hasOwnProperty.call(rooms, roomId) && rooms[roomId] === status) return;
  guestStorage.set(STATUS_STORAGE_KEY, JSON.stringify({ userId, rooms: { ...rooms, [roomId]: status } }));
}
