import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AvatarId } from '../../../../shared/presence';
import { Avatar } from '../../components/ui/Avatar';
import { isNickname } from './localIdentity';

const avatars: { id: AvatarId; label: string }[] = [
  { id: 'dark', label: 'Dark hair' }, { id: 'pink', label: 'Pink hair' }, { id: 'green', label: 'Green sweater' },
];

export function JoinRoomDialog({ roomName, account, onJoin }: { roomName: string; account: boolean; onJoin: (nickname: string, avatar: AvatarId) => void | Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState<AvatarId>('dark');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isNickname(nickname)) { setError('Choose a nickname with 1–24 characters.'); return; }
    setSaving(true); setError(null);
    try { await onJoin(nickname.trim(), avatar); }
    catch (reason) { setError(reason instanceof Error ? reason.message : account ? 'Your profile could not be saved.' : 'Your identity could not be saved. Allow browser storage and try again.'); }
    finally { setSaving(false); }
  };

  return (
    <dialog ref={dialog} className="room-settings join-room-dialog" aria-labelledby="join-title" onCancel={event => event.preventDefault()}>
      <form className="settings-content" onSubmit={submit}>
        <p className="eyebrow"><span className="tiny-star" aria-hidden="true">✦</span> A LITTLE COMPANY</p>
        <h2 id="join-title">Join {roomName}</h2>
        <p className="settings-hint">{account ? 'Create the profile that follows your account everywhere.' : 'Pick a name and make yourself at home.'}</p>
        <label className="join-nickname" htmlFor="join-nickname">Nickname</label>
        <input id="join-nickname" autoFocus autoComplete="nickname" maxLength={24} required placeholder="kei" value={nickname} onChange={event => { setNickname(event.target.value); setError(null); }} aria-describedby={error ? 'join-error' : undefined} />
        <fieldset className="join-avatars">
          <legend>Choose avatar</legend>
          {avatars.map(choice => <label key={choice.id}>
            <input type="radio" name="avatar" value={choice.id} checked={avatar === choice.id} onChange={() => setAvatar(choice.id)} />
            <span><Avatar avatar={choice.id} /><span>{choice.label}</span></span>
          </label>)}
        </fieldset>
        {error && <p id="join-error" className="join-error" role="alert">{error}</p>}
        <button className="primary-button settings-done" disabled={!isNickname(nickname) || saving}>{saving ? 'Saving…' : 'Join room'}</button>
      </form>
    </dialog>
  );
}
