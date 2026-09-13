import type { RoomStatePayload } from '../../../../shared/roomState';

export interface ReceivedRoomState { state: RoomStatePayload; socketId: string }

export function receiveRoomState(previous: ReceivedRoomState | null, state: RoomStatePayload, socketId: string): ReceivedRoomState {
  if (previous?.socketId === socketId && previous.state.roomId === state.roomId && state.revision <= previous.state.revision) return previous;
  return { state, socketId };
}
