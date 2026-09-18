import type { Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, RoomResult, RoomUser } from '../../../shared/presence.js';
import type { RoomStatePayload } from '../../../shared/roomState.js';
import { RoomStateError, type RoomMutation, type RoomRepository } from '../repositories/roomRepository.js';
import { databaseErrorCode } from '../db/pool.js';
import { readRoomId } from './validation.js';
import { log } from '../logger.js';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max && !/[\u0000-\u001f\u007f]/.test(value);

export function attachPersistentRoomHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents>, repository: RoomRepository,
  member: (roomId: string) => RoomUser | null | Promise<RoomUser | null>,
  broadcast: (state: RoomStatePayload) => void,
  studies?: { sessionId(roomId: string, guestId: string): string | undefined | Promise<string | undefined>; flush(roomId?: string): Promise<void> },
  schedule: (work: () => Promise<void>) => void = work => { void work(); },
) {
  for (const operation of ['tasks:sync', 'task:create', 'task:toggle', 'task:delete', 'room:rename'] as const) {
    socket.on(operation, (input: unknown, acknowledge?: (result: RoomResult) => void) => schedule(async () => {
      const fail = (message: string) => {
        if (!socket.connected) return;
        socket.emit('room:error', { operation, message });
        if (typeof acknowledge === 'function') acknowledge({ ok: false, error: message });
      };
      const roomId = readRoomId(input);
      if (!roomId) { fail('A valid room is required.'); return; }
      let creator: RoomUser | null;
      try { creator = await member(roomId); }
      catch { fail('The realtime state service is unavailable. Reconnect before changing saved room state.'); return; }
      if (!creator) { fail('Join this room before changing its saved state.'); return; }
      const payload = input as Record<string, unknown>;
      let action: RoomMutation | undefined;
      if (operation === 'task:create') {
        if (!text(payload.title, 100) || !uuid(payload.requestId)) { fail('Enter a task with 1–100 characters and a valid request ID.'); return; }
        action = { kind: 'create', title: payload.title.trim(), requestId: payload.requestId, creator };
      } else if (operation === 'task:toggle' || operation === 'task:delete') {
        if (!uuid(payload.taskId) || (operation === 'task:toggle' && typeof payload.completed !== 'boolean')) { fail('Choose a valid task and completion state.'); return; }
        action = operation === 'task:delete' ? { kind: 'delete', taskId: payload.taskId } : { kind: 'toggle', taskId: payload.taskId, completed: payload.completed as boolean };
      } else if (operation === 'room:rename') {
        if (!text(payload.name, 32)) { fail('Choose a room name with 1–32 characters.'); return; }
        action = { kind: 'rename', name: payload.name.trim() };
      }
      try {
        if (action?.kind === 'toggle' && action.completed && studies) {
          const sessionId = await studies.sessionId(roomId, creator.id);
          if (!sessionId) { fail('Rejoin the room before completing a task.'); return; }
          action.contribution = { sessionId, guestId: creator.id, at: Date.now() };
          await studies.flush(roomId);
        }
        // Authorization is checked at receipt. A committed change must reach the
        // original room even if its requester navigates away during the query.
        const state = action ? await repository.mutate(roomId, action) : await repository.load(roomId, false);
        if (action) broadcast(state);
        else if (socket.connected && await member(roomId)) socket.emit('room:state', state);
        if (typeof acknowledge === 'function') acknowledge({ ok: true });
      } catch (error) {
        if (error instanceof RoomStateError) fail(error.message);
        else {
          log('error', 'database.mutation_failed', `[database] ${operation} failed (${databaseErrorCode(error)}).`, { operation, code: databaseErrorCode(error) });
          fail('Saved room data is temporarily unavailable. Try again when the database is back.');
        }
      }
    }));
  }
}
