import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { RoomStatePayload, RoomTask } from '../../../shared/roomState.js';
import { RoomNotFoundError, RoomStateError, type RoomMutation, type RoomRepository } from './roomRepository.js';
import { insertStudyActivity } from '../db/studyActivity.js';

interface RoomRow { id: string; name: string; revision: number; created_at: Date; updated_at: Date }
interface TaskRow {
  id: string; room_id: string; title: string; completed: boolean; created_by: string;
  creator_name: string; creator_avatar: RoomTask['creatorAvatar']; request_id: string;
  created_at: Date; updated_at: Date;
}

/** Transactions lock only their room row; full snapshots carry a durable revision. */
export class PostgresRoomRepository implements RoomRepository {
  constructor(private pool: Pool) {}

  async health() { await this.pool.query('SELECT 1'); }
  load(roomId: string, createIfMissing = true) { return this.transaction(roomId, undefined, createIfMissing); }
  mutate(roomId: string, action: RoomMutation) { return this.transaction(roomId, action); }

  private async transaction(roomId: string, action?: RoomMutation, createIfMissing = false): Promise<RoomStatePayload> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (!action && createIfMissing) await client.query('INSERT INTO rooms(id) VALUES ($1) ON CONFLICT(id) DO NOTHING', [roomId]);
      const found = await client.query<RoomRow>('SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
      if (!found.rowCount) throw new RoomNotFoundError();
      let room = found.rows[0];
      if (action && await this.apply(client, room, action)) {
        room = (await client.query<RoomRow>('UPDATE rooms SET revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *', [roomId])).rows[0];
      }
      const tasks = await client.query<TaskRow>('SELECT * FROM tasks WHERE room_id = $1 ORDER BY created_at, id', [roomId]);
      await client.query('COMMIT');
      return {
        roomId, revision: room.revision,
        room: { id: room.id, name: room.name, createdAt: room.created_at.getTime(), updatedAt: room.updated_at.getTime() },
        tasks: tasks.rows.map(task => ({
          id: task.id, roomId: task.room_id, title: task.title, completed: task.completed,
          createdBy: task.created_by, creatorName: task.creator_name, creatorAvatar: task.creator_avatar,
          requestId: task.request_id, createdAt: task.created_at.getTime(), updatedAt: task.updated_at.getTime(),
        })),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  private async apply(client: PoolClient, room: RoomRow, action: RoomMutation): Promise<boolean> {
    if (action.kind === 'rename') {
      if (room.name === action.name) return false;
      await client.query('UPDATE rooms SET name = $2 WHERE id = $1', [room.id, action.name]);
      return true;
    }
    if (action.kind === 'create') {
      const existing = await client.query<TaskRow>('SELECT * FROM tasks WHERE room_id = $1 AND request_id = $2', [room.id, action.requestId]);
      if (existing.rowCount) {
        if (existing.rows[0].created_by !== action.creator.id || existing.rows[0].title !== action.title) throw new RoomStateError('This task request was already used. Try creating a new task.');
        return false;
      }
      await client.query(`INSERT INTO tasks(id, room_id, title, created_by, creator_name, creator_avatar, request_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), room.id, action.title, action.creator.id, action.creator.nickname, action.creator.avatar, action.requestId]);
      return true;
    }
    const task = (await client.query<TaskRow>('SELECT * FROM tasks WHERE room_id = $1 AND id = $2', [room.id, action.taskId])).rows[0];
    if (!task) throw new RoomStateError('That task no longer exists in this room. Refresh the task list.');
    if (action.kind === 'delete') await client.query('DELETE FROM tasks WHERE room_id = $1 AND id = $2', [room.id, action.taskId]);
    else {
      if (task.completed === action.completed) return false;
      await client.query('UPDATE tasks SET completed = $3, updated_at = clock_timestamp() WHERE room_id = $1 AND id = $2', [room.id, action.taskId, action.completed]);
      if (action.completed && action.contribution) {
        const now = action.contribution.at;
        await insertStudyActivity(client, { kind: 'activity', activity: 'task', sessionId: action.contribution.sessionId,
          referenceId: task.id, start: now, end: now, focusMs: 0 }, { roomId: room.id, guestId: action.contribution.guestId });
      }
    }
    return true;
  }
}
