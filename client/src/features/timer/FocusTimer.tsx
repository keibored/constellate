import { Pause, Play, RotateCcw, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';

interface FocusTimerProps { minutes: number; onSettings: () => void }

export function FocusTimer({ minutes, onSettings }: FocusTimerProps) {
  const [remaining, setRemaining] = useState(minutes * 60);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  useEffect(() => {
    if (endsAt === null) return;
    const tick = () => { const next = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)); setRemaining(next); if (next === 0) setEndsAt(null); };
    tick();
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [endsAt]);
  const reset = () => { setEndsAt(null); setRemaining(minutes * 60); };
  const toggle = () => {
    if (endsAt !== null) { setRemaining(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))); setEndsAt(null); }
    else { const seconds = remaining || minutes * 60; setRemaining(seconds); setEndsAt(Date.now() + seconds * 1000); }
  };
  const time = `${Math.floor(remaining / 60).toString().padStart(2, '0')}:${(remaining % 60).toString().padStart(2, '0')}`;
  return (
    <section className="focus-timer" aria-label="Focus timer">
      <div className="timer-heading"><span className="tiny-star">✦</span><h2>Focus</h2><span className="tiny-star">✦</span></div>
      <div className="timer-digits" role="timer" aria-label={`${Math.floor(remaining / 60)} minutes, ${remaining % 60} seconds`}>{time}</div>
      <div className="timer-controls"><button className="icon-button" aria-label="Reset focus timer" onClick={reset}><RotateCcw size={16} /></button><button className="primary-button timer-start" onClick={toggle}>{endsAt !== null ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{endsAt !== null ? 'Pause' : 'Start'}</button><button className="icon-button" aria-label="Timer settings" onClick={onSettings}><Settings2 size={16} /></button></div>
      <p className="timer-note" aria-live="polite">{remaining === 0 ? 'You did it. Take a little break ♡' : 'one thing at a time'}</p>
    </section>
  );
}
