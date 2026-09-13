import assert from 'node:assert/strict';
import { test } from 'node:test';
import { receiveRoomState } from '../../client/src/features/tasks/roomState.js';
import type { RoomStatePayload } from '../../shared/roomState.js';

const state: RoomStatePayload = { roomId: 'demo', room: { id: 'demo', name: 'Saved room', createdAt: 1, updatedAt: 2 }, tasks: [], revision: 10 };

test('a slow saved-room response cannot replace a newer revision; reconnect and room switches accept fresh snapshots', () => {
  const current = receiveRoomState(null, state, 'socket-a');
  assert.equal(receiveRoomState(current, { ...state, revision: 9 }, 'socket-a'), current);
  assert.equal(receiveRoomState(current, { ...state }, 'socket-a'), current);
  assert.equal(receiveRoomState(current, { ...state, revision: 11 }, 'socket-a').state.revision, 11);
  assert.equal(receiveRoomState(current, state, 'socket-b').socketId, 'socket-b');
  assert.equal(receiveRoomState(current, { ...state, roomId: 'other', revision: 0 }, 'socket-a').state.roomId, 'other');
});
