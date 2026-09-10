import { Pause, Play, RotateCcw, Settings2 } from 'lucide-react';
import type { ConnectionStatus } from '../presence/useRoomPresence';
import { useRoomTimer } from './useRoomTimer';

interface FocusTimerProps { roomId: string; connection: ConnectionStatus; onSettings: () => void }

export function FocusTimer({ roomId, connection, onSettings }: FocusTimerProps) {
  const timer = useRoomTimer(roomId, connection);
  const phase = timer.state?.phase === 'shortBreak' ? 'Break' : 'Focus';
  const running = timer.state?.status === 'running';
  const paused = timer.state?.status === 'paused';
  const control = running ? timer.pause : paused ? timer.resume : timer.start;
  const note = timer.error ?? (connection === 'reconnecting' ? 'Reconnecting to the room…' : !timer.state ? 'Join the room to focus together' : timer.seconds === 0 ? 'A new phase is on its way…' : phase === 'Break' ? 'a little room to breathe' : 'one thing at a time');
  return (
    <section className="focus-timer" aria-label="Shared Pomodoro timer" data-phase={timer.state?.phase} data-status={timer.state?.status} data-revision={timer.state?.revision}>
      <div className="timer-heading"><span className="tiny-star">✦</span><h2>{phase}</h2><span className="tiny-star">✦</span></div>
      <div className="timer-digits" role="timer" aria-label={timer.state ? `${Math.floor(timer.seconds / 60)} minutes, ${timer.seconds % 60} seconds` : 'Waiting for room timer'}>{timer.formattedTime}</div>
      <div className="timer-controls"><button className="icon-button" aria-label="Reset focus timer" disabled={!timer.canControl} onClick={timer.reset}><RotateCcw size={16} /></button><button className="primary-button timer-start" disabled={!timer.canControl} aria-busy={timer.pending} onClick={control}>{running ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{running ? 'Pause' : paused ? 'Resume' : 'Start'}</button><button className="icon-button" aria-label="Timer settings" onClick={onSettings}><Settings2 size={16} /></button></div>
      <p className="timer-note" aria-live="polite">{note}</p>
    </section>
  );
}
