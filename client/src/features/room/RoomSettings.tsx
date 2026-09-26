import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Moon, X } from 'lucide-react';
import type { AvatarId } from '../../../../shared/presence';
import { Avatar } from '../../components/ui/Avatar';
import { isNickname, type LocalIdentity } from '../presence/localIdentity';

interface RoomSettingsProps {
  open: boolean; onClose: () => void;
  reducedMotion: boolean; onMotionChange: (value: boolean) => void;
  identity: LocalIdentity | null;
  accountProfile: boolean;
  onProfileSave: (nickname: string, avatar: AvatarId) => Promise<void>;
}

const avatars: AvatarId[] = ['dark', 'pink', 'green'];

export function RoomSettings({ open, onClose, reducedMotion, onMotionChange, identity, accountProfile, onProfileSave }: RoomSettingsProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState<AvatarId>('dark');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setNickname(identity?.nickname ?? ''); setAvatar(identity?.avatar ?? 'dark'); setError(null);
      dialogRef.current?.showModal();
    } else dialogRef.current?.close();
  }, [open, identity]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isNickname(nickname)) { setError('Choose a nickname with 1–24 characters.'); return; }
    setSaving(true); setError(null);
    try { await onProfileSave(nickname.trim(), avatar); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Your profile could not be saved.'); }
    finally { setSaving(false); }
  };
  return (
    <dialog ref={dialogRef} className="room-settings" onCancel={onClose} onClose={onClose} aria-labelledby="settings-title" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="settings-content" onSubmit={submit}><div className="panel-heading"><h2 id="settings-title"><Moon size={18} />Settle in</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Close settings"><X size={18} /></button></div>
        <label className="join-nickname" htmlFor="profile-nickname">Nickname</label>
        <input id="profile-nickname" maxLength={24} value={nickname} onChange={event => { setNickname(event.target.value); setError(null); }} />
        <div className="profile-avatar-options" aria-label="Choose avatar">{avatars.map(choice => <button type="button" className={avatar === choice ? 'profile-avatar profile-avatar--selected' : 'profile-avatar'} key={choice} aria-label={`${choice} avatar`} aria-pressed={avatar === choice} onClick={() => setAvatar(choice)}><Avatar avatar={choice} /></button>)}</div>
        <p className="settings-hint">{accountProfile ? 'This profile syncs across every browser where you sign in.' : 'Guest profiles stay in this browser.'}</p>
        <label className="settings-field"><span>Focus session</span><select value={25} disabled><option value={25}>25 minutes</option></select></label>
        <p className="settings-hint">Shared focus: 25 minutes. Short break: 5 minutes.</p>
        <label className="motion-setting"><span>Still room<small>Pause the little ambient animations</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => onMotionChange(event.target.checked)} /></label>
        {error && <p className="join-error" role="alert">{error}</p>}
        <button className="primary-button settings-done" disabled={saving || !isNickname(nickname)}>{saving ? 'Saving…' : 'Save profile'}</button>
      </form>
    </dialog>
  );
}
