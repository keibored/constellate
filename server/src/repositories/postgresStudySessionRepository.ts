import type { Pool, PoolClient } from 'pg';
import type { PersonalStats, RoomStudyStats, StudyHistory, StudySessionRecord, StudyTotals } from '../../../shared/stats.js';
import { DatabaseSetupError } from '../db/migrations.js';
import { databaseErrorCode } from '../db/pool.js';
import { insertStudyActivity } from '../db/studyActivity.js';
import type { StudySessionRepository, StudyWrite } from './studySessionRepository.js';

const lockKey = "hashtext(current_database()), hashtext(current_schema() || ':constellate-study')";
const totals = (row: Record<string, unknown>): StudyTotals => ({ focusSeconds: Number(row.focus_seconds ?? 0),
  completedPomodoros: Number(row.completed_pomodoros ?? 0), completedTasks: Number(row.completed_tasks ?? 0) });

export class PostgresStudySessionRepository implements StudySessionRepository {
  private lease?: PoolClient;
  private leaseLost = false;
  constructor(private pool: Pool) {}

  /** One backend per schema. A live backend cannot have its sessions marked stale. */
  async recover() {
    const lease = await this.pool.connect();
    let result;
    try { result = await lease.query(`SELECT pg_try_advisory_lock(${lockKey}) AS acquired`); }
    catch (error) { lease.release(true); throw error; }
    if (!result.rows[0].acquired) { lease.release(); throw new DatabaseSetupError('Another Constellate backend owns study tracking for this database. Stop it before starting another.'); }
    this.lease = lease;
    lease.on('error', error => { this.leaseLost = true; console.error(`[study] Backend ownership connection lost (${databaseErrorCode(error)}). Restart the backend.`); });
    try {
      await lease.query('BEGIN');
      await lease.query("UPDATE study_sessions SET ended_at = last_checkpoint_at, end_reason = 'server_restart' WHERE ended_at IS NULL");
      await lease.query('UPDATE room_study_sessions SET ended_at = last_checkpoint_at WHERE ended_at IS NULL');
      await lease.query('COMMIT');
    } catch (error) { await lease.query('ROLLBACK').catch(() => {}); await this.release(); throw error; }
  }
  async release() {
    const lease = this.lease;
    this.lease = undefined;
    if (lease) {
      try { if (!this.leaseLost) await lease.query(`SELECT pg_advisory_unlock(${lockKey})`); }
      finally { lease.release(this.leaseLost); }
    }
  }
  async write(events: readonly StudyWrite[]) {
    if (this.leaseLost) throw new Error('Study tracking backend ownership was lost.');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const event of events) {
        if (event.kind === 'roomStart') await client.query(`INSERT INTO room_study_sessions(id, room_id, started_at, last_checkpoint_at)
          SELECT $1, id, $3, $3 FROM rooms WHERE id = $2 ON CONFLICT(id) DO NOTHING`, [event.id, event.roomId, new Date(event.at)]);
        else if (event.kind === 'sessionStart') await client.query(`INSERT INTO study_sessions(id, room_id, room_study_session_id, guest_id, started_at, last_checkpoint_at)
          SELECT $1, room_id, id, $3, $4, $4 FROM room_study_sessions WHERE id = $2 ON CONFLICT(id) DO NOTHING`,
        [event.id, event.roomSessionId, event.guestId, new Date(event.at)]);
        else if (event.kind === 'activity') await insertStudyActivity(client, event);
        else if (event.kind === 'sessionEnd') await client.query(`UPDATE study_sessions SET ended_at = GREATEST(started_at, $2),
          last_checkpoint_at = GREATEST(last_checkpoint_at, $2), end_reason = $3 WHERE id = $1 AND ended_at IS NULL`, [event.id, new Date(event.at), event.reason]);
        else if (event.kind === 'roomEnd') await client.query(`UPDATE room_study_sessions SET ended_at = GREATEST(started_at, $2),
          last_checkpoint_at = GREATEST(last_checkpoint_at, $2) WHERE id = $1 AND ended_at IS NULL`, [event.id, new Date(event.at)]);
        else {
          await client.query('UPDATE study_sessions SET last_checkpoint_at = GREATEST(last_checkpoint_at, $2) WHERE id = ANY($1::uuid[]) AND ended_at IS NULL', [event.sessionIds, new Date(event.at)]);
          await client.query('UPDATE room_study_sessions SET last_checkpoint_at = GREATEST(last_checkpoint_at, $2) WHERE id = ANY($1::uuid[]) AND ended_at IS NULL', [event.roomSessionIds, new Date(event.at)]);
        }
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async personal(guestId: string, timezone: string, now = Date.now()): Promise<PersonalStats> {
    // The next local midnight is derived before converting back to timestamptz,
    // so 23/25-hour daylight-saving days are handled correctly.
    const result = await this.pool.query(`WITH day AS (
      SELECT date_trunc('day', $3::timestamptz AT TIME ZONE $2) AS local_start
    ), bounds AS (SELECT local_start AT TIME ZONE $2 AS lo, (local_start + interval '1 day') AT TIME ZONE $2 AS hi FROM day),
    overall AS (SELECT COALESCE(sum(focus_seconds),0) AS focus_seconds,
      COALESCE(sum(completed_pomodoros),0) AS completed_pomodoros, COALESCE(sum(completed_tasks),0) AS completed_tasks,
      count(*) AS sessions FROM study_sessions WHERE guest_id = $1),
    today AS (SELECT
      COALESCE(sum(CASE WHEN a.kind = 'focus' THEN EXTRACT(epoch FROM (LEAST(a.ended_at, b.hi) - GREATEST(a.started_at, b.lo))) ELSE 0 END),0) AS focus_seconds,
      count(*) FILTER (WHERE a.kind = 'pomodoro') AS completed_pomodoros,
      count(*) FILTER (WHERE a.kind = 'task') AS completed_tasks
      FROM study_activity a JOIN study_sessions s ON s.id = a.session_id CROSS JOIN bounds b
      WHERE s.guest_id = $1 AND a.ended_at >= b.lo AND a.started_at < b.hi)
    SELECT row_to_json(overall) AS overall, row_to_json(today) AS today FROM overall, today`, [guestId, timezone, new Date(now)]);
    const row = result.rows[0];
    return { today: totals(row.today), overall: { ...totals(row.overall), sessions: Number(row.overall.sessions) }, timezone, asOf: now };
  }

  async history(guestId: string, limit: number, before?: { at: number; id: string }): Promise<StudyHistory> {
    const result = await this.pool.query(`SELECT s.*, r.name AS room_name,
      EXTRACT(epoch FROM (COALESCE(s.ended_at, clock_timestamp()) - s.started_at)) AS duration_seconds
      FROM study_sessions s JOIN rooms r ON r.id = s.room_id WHERE s.guest_id = $1
      AND ($3::timestamptz IS NULL OR (s.started_at, s.id) < ($3, $4::uuid))
      ORDER BY s.started_at DESC, s.id DESC LIMIT $2`, [guestId, limit + 1, before ? new Date(before.at) : null, before?.id ?? null]);
    const rows = result.rows.slice(0, limit);
    const sessions: StudySessionRecord[] = rows.map(row => ({ ...totals(row), id: row.id, roomId: row.room_id, roomName: row.room_name,
      startedAt: row.started_at.getTime(), endedAt: row.ended_at?.getTime() ?? null, durationSeconds: Math.max(0, Number(row.duration_seconds)), endReason: row.end_reason }));
    const last = sessions.at(-1);
    return { sessions, nextCursor: result.rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.startedAt, id: last.id })).toString('base64url') : null };
  }

  async room(roomId: string, now = Date.now()): Promise<RoomStudyStats | null> {
    const result = await this.pool.query(`SELECT r.name,
      (SELECT COALESCE(sum(focus_seconds),0) FROM study_sessions WHERE room_id = r.id) AS focus_seconds,
      (SELECT count(DISTINCT a.reference_id) FROM study_activity a JOIN study_sessions s ON s.id = a.session_id
        WHERE s.room_id = r.id AND a.kind = 'pomodoro') AS completed_pomodoros,
      (SELECT COALESCE(sum(completed_tasks),0) FROM study_sessions WHERE room_id = r.id) AS completed_tasks
      FROM rooms r WHERE r.id = $1`, [roomId]);
    if (!result.rowCount) return null;
    const runs = await this.pool.query(`SELECT started_at, ended_at FROM room_study_sessions WHERE room_id = $1
      ORDER BY started_at DESC, id DESC LIMIT 2`, [roomId]);
    const current = runs.rows.find(row => !row.ended_at);
    const last = runs.rows.find(row => row.ended_at);
    return { ...totals(result.rows[0]), roomId, roomName: result.rows[0].name, asOf: now,
      currentSession: current ? { startedAt: current.started_at.getTime(), durationSeconds: Math.max(0, (now - current.started_at.getTime()) / 1000) } : null,
      lastSession: last ? { startedAt: last.started_at.getTime(), endedAt: last.ended_at.getTime(), durationSeconds: (last.ended_at - last.started_at) / 1000 } : null };
  }
}
