import type { RoomStatePayload } from '../../../shared/roomState.js';
import type { RoomUser } from '../../../shared/presence.js';

export type RoomMutation =
  | { kind: 'create'; title: string; requestId: string; creator: RoomUser }
  | { kind: 'toggle'; taskId: string; completed: boolean; contribution?: { sessionId: string; guestId: string; at: number } }
  | { kind: 'delete'; taskId: string }
  | { kind: 'rename'; name: string };

export interface RoomRepository {
  load(roomId: string, createIfMissing?: boolean): Promise<RoomStatePayload>;
  mutate(roomId: string, action: RoomMutation): Promise<RoomStatePayload>;
  health(): Promise<void>;
  exists?(roomId: string): Promise<boolean>;
}

export interface OwnedRoomSummary {
  id: string;
  name: string;
  visibility: 'public' | 'private';
  createdAt: number;
  updatedAt: number;
}

export interface OwnedRoomRepository {
  createOwned(roomId: string, ownerUserId: string, name: string): Promise<OwnedRoomSummary>;
  listOwned(ownerUserId: string): Promise<OwnedRoomSummary[]>;
}

export class RoomStateError extends Error {}
export class RoomNotFoundError extends RoomStateError {
  constructor() { super('This saved room no longer exists. Leave this room and choose another.'); }
}
