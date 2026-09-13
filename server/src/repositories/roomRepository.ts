import type { RoomStatePayload } from '../../../shared/roomState.js';
import type { RoomUser } from '../../../shared/presence.js';

export type RoomMutation =
  | { kind: 'create'; title: string; requestId: string; creator: RoomUser }
  | { kind: 'toggle'; taskId: string; completed: boolean }
  | { kind: 'delete'; taskId: string }
  | { kind: 'rename'; name: string };

export interface RoomRepository {
  load(roomId: string): Promise<RoomStatePayload>;
  mutate(roomId: string, action: RoomMutation): Promise<RoomStatePayload>;
  health(): Promise<void>;
}

export class RoomStateError extends Error {}
