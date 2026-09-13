import { randomUUID } from 'node:crypto';
import type { RoomRepository, RoomMutation } from '../../src/repositories/roomRepository.js';
import { RoomNotFoundError, RoomStateError } from '../../src/repositories/roomRepository.js';
import type { RoomStatePayload } from '../../../shared/roomState.js';

/** Explicit test double for transport/unit tests. Production always injects PostgreSQL. */
export class TestRoomRepository implements RoomRepository {
  readonly rooms = new Map<string, RoomStatePayload>();
  async health() {}
  async load(roomId: string, createIfMissing = true) {
    if (!this.rooms.has(roomId) && !createIfMissing) throw new RoomNotFoundError();
    if (!this.rooms.has(roomId)) this.rooms.set(roomId, { roomId, revision: 0, room: { id: roomId, name: 'Late night grind', createdAt: Date.now(), updatedAt: Date.now() }, tasks: [] });
    return structuredClone(this.rooms.get(roomId)!);
  }
  async mutate(roomId: string, action: RoomMutation) {
    const state = await this.load(roomId);
    if (action.kind === 'rename') state.room.name = action.name;
    else if (action.kind === 'create') {
      const exists = state.tasks.find(task => task.requestId === action.requestId);
      if (exists) return state;
      state.tasks.push({ id: randomUUID(), roomId, title: action.title, completed: false, createdBy: action.creator.id, creatorName: action.creator.nickname, creatorAvatar: action.creator.avatar, requestId: action.requestId, createdAt: Date.now(), updatedAt: Date.now() });
    } else {
      const task = state.tasks.find(task => task.id === action.taskId);
      if (!task) throw new RoomStateError('That task no longer exists in this room.');
      if (action.kind === 'delete') state.tasks = state.tasks.filter(task => task.id !== action.taskId);
      else task.completed = action.completed;
    }
    state.revision++;
    state.room.updatedAt = Date.now();
    this.rooms.set(roomId, structuredClone(state));
    return state;
  }
}
