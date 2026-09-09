import { useEffect, useRef } from 'react';
import { Moon, X } from 'lucide-react';

interface RoomSettingsProps {
  open: boolean; onClose: () => void;
  minutes: number; onMinutesChange: (minutes: number) => void;
  reducedMotion: boolean; onMotionChange: (value: boolean) => void;
}

export function RoomSettings({ open, onClose, minutes, onMinutesChange, reducedMotion, onMotionChange }: RoomSettingsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [open]);
  return (
    <dialog ref={dialogRef} className="room-settings" onCancel={onClose} onClose={onClose} aria-labelledby="settings-title" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="settings-content"><div className="panel-heading"><h2 id="settings-title"><Moon size={18} />Settle in</h2><button className="icon-button" onClick={onClose} aria-label="Close settings"><X size={18} /></button></div>
        <label className="settings-field"><span>Focus session</span><select value={minutes} onChange={(event) => onMinutesChange(Number(event.target.value))}><option value={15}>15 minutes</option><option value={25}>25 minutes</option><option value={50}>50 minutes</option></select></label>
        <p className="settings-hint">Changing the duration resets your timer.</p>
        <label className="motion-setting"><span>Still room<small>Pause the little ambient animations</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => onMotionChange(event.target.checked)} /></label>
        <button className="primary-button settings-done" onClick={onClose}>Make yourself at home</button>
      </div>
    </dialog>
  );
}
