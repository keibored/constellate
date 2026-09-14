import type { PoolClient } from 'pg';
import type { StudyActivity } from '../repositories/studySessionRepository.js';

/** Must run on the caller's transaction: retrying an event cannot add it twice. */
export async function insertStudyActivity(client: PoolClient, event: StudyActivity, owner?: { roomId: string; guestId: string }) {
  const inserted = await client.query(`INSERT INTO study_activity(session_id, kind, reference_id, started_at, ended_at, focus_ms)
    SELECT id, $2, $3, $4, $5, $6 FROM study_sessions WHERE id = $1
      AND ($7::text IS NULL OR (room_id = $7 AND guest_id = $8))
    ON CONFLICT DO NOTHING RETURNING session_id`,
  [event.sessionId, event.activity, event.referenceId, new Date(event.start), new Date(event.end), event.focusMs, owner?.roomId ?? null, owner?.guestId ?? null]);
  if (inserted.rowCount) await client.query(`UPDATE study_sessions SET
    focus_ms = focus_ms + $2, completed_pomodoros = completed_pomodoros + $3,
    completed_tasks = completed_tasks + $4,
    last_checkpoint_at = CASE WHEN ended_at IS NULL THEN GREATEST(last_checkpoint_at, $5) ELSE last_checkpoint_at END WHERE id = $1`,
  [event.sessionId, event.focusMs, Number(event.activity === 'pomodoro'), Number(event.activity === 'task'), new Date(event.end)]);
  if (inserted.rowCount && event.activity === 'task') await client.query(`UPDATE room_study_sessions SET last_checkpoint_at = GREATEST(last_checkpoint_at, $2)
    WHERE id = (SELECT room_study_session_id FROM study_sessions WHERE id = $1) AND ended_at IS NULL`, [event.sessionId, new Date(event.end)]);
}
