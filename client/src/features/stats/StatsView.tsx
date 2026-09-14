import { BookOpen, Clock3, History, RefreshCw, Sparkles } from 'lucide-react';
import type { StudyTotals } from '../../../../shared/stats';
import type { ConnectionStatus } from '../../services/roomConnection';
import { useStudyStats } from './useStudyStats';
import '../../styles/stats.css';

export function formatStudyTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function Totals({ values, room = false }: { values: StudyTotals; room?: boolean }) {
  return <dl className="study-totals">
    <div><dt>Focused</dt><dd>{formatStudyTime(values.focusSeconds)}</dd></div>
    <div><dt>Pomodoros</dt><dd>{values.completedPomodoros}</dd></div>
    <div><dt>{room ? 'Task contributions' : 'Tasks completed'}</dt><dd>{values.completedTasks}</dd></div>
  </dl>;
}
export function StatsView({ roomId, connection }: { roomId: string; connection: ConnectionStatus }) {
  const stats = useStudyStats(roomId, connection);
  const online = connection === 'connected';
  return <main className="study-stats" id="stats" tabIndex={-1} aria-labelledby="stats-title" aria-busy={stats.loading}>
    <div className="study-stats-heading"><div><p className="eyebrow"><Sparkles size={14} /> YOUR FOCUS</p><h1 id="stats-title">A little record of your effort.</h1><p className="settings-hint">Small steps, saved along the way.</p></div>
      <button className="add-task-button" disabled={!online || stats.loading} onClick={() => { void stats.refresh(); }}><RefreshCw size={14} />Refresh stats</button></div>
    {!online && <p className="study-feedback" role="status">{connection === 'idle' ? 'Join the room to see your study history.' : 'Reconnecting. Your saved history will return with the room.'}</p>}
    {stats.error && <p className="study-feedback" role="alert">{stats.error}</p>}
    {!stats.personal && stats.loading && <p className="study-feedback" role="status">Gathering your study notes…</p>}
    {stats.personal && <>
      <div className="study-summary-grid">
        <section className="sidebar-panel study-card"><h2><Clock3 size={17} />Today</h2><Totals values={stats.personal.today} /><p className="panel-footnote">Your day in {stats.personal.timezone.replace(/_/g, ' ')}.</p></section>
        <section className="sidebar-panel study-card"><h2><Sparkles size={17} />All time</h2><Totals values={stats.personal.overall} /><p className="panel-footnote">{stats.personal.overall.sessions} study {stats.personal.overall.sessions === 1 ? 'session' : 'sessions'}, including your current visit.</p></section>
      </div>
      <p className="study-caption">Focus follows the shared timer. Pauses, breaks and disconnected time stay out of your focus total.</p>
    </>}
    {stats.room && <section className="sidebar-panel study-card study-room-summary"><div className="panel-heading"><h2><BookOpen size={17} />This room · {stats.room.roomName}</h2><span className="panel-sparkle" aria-hidden="true">✧</span></div>
      <Totals values={stats.room} room />
      <div className="study-room-duration"><p>Current gathering <strong>{stats.room.currentSession ? formatStudyTime(stats.room.currentSession.durationSeconds) : 'Room is quiet'}</strong></p>
        {stats.room.lastSession && <p>Previous gathering <strong>{formatStudyTime(stats.room.lastSession.durationSeconds)}</strong></p>}</div>
      <p className="panel-footnote">Focus adds up across members. A shared Pomodoro counts once for the room.</p>
    </section>}
    {stats.history && <section className="sidebar-panel study-card study-history" aria-labelledby="history-title"><div className="panel-heading"><h2 id="history-title"><History size={17} />Recent sessions</h2><span className="panel-sparkle" aria-hidden="true">✧</span></div>
      {!stats.history.sessions.length && <p className="settings-hint">Your next visit is a fresh page. Study a little, and your history will grow here.</p>}
      <ul>{stats.history.sessions.map(session => <li key={session.id} data-study-session={session.id}>
        <div><h3>{session.roomName}</h3><p>{formatStudyTime(session.focusSeconds)} focused <span aria-hidden="true">·</span> {session.completedPomodoros} Pomodoros <span aria-hidden="true">·</span> {session.completedTasks} tasks</p><p className="study-session-duration">{formatStudyTime(session.durationSeconds)} in room{session.endReason === 'server_restart' ? ' · Saved before restart' : ''}</p></div>
        <div className="study-session-date"><time dateTime={new Date(session.startedAt).toISOString()}>{new Date(session.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {new Date(session.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time><span>{session.endedAt === null ? 'In progress' : 'Session ended'}</span></div>
      </li>)}</ul>
      {stats.history.nextCursor && <button className="invite-button" disabled={!online || stats.loading} onClick={() => { void stats.loadMore(); }}>Load earlier sessions</button>}
    </section>}
    <p className="study-caption">{stats.personal ? `Updated ${new Date(stats.personal.asOf).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}. ` : ''}Use Refresh stats for your latest activity. Your personal history belongs to this browser's guest identity.</p>
  </main>;
}
