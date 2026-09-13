import { useState } from 'react';
import { isRoomId } from '../presence/localSession';

/** A small destination for explicit leave; direct room links still join normally. */
export function RoomLobby() {
  const [roomId, setRoomId] = useState('');
  const [error, setError] = useState<string | null>(null);
  return <main className="not-found">
    <span className="brand-star" aria-hidden="true">✦</span>
    <h1>Find your study room.</h1>
    <form className="room-entry-form" onSubmit={event => {
      event.preventDefault();
      const value = roomId.trim();
      if (!isRoomId(value)) { setError('Use 1–64 letters, numbers, hyphens or underscores, starting with a letter or number.'); return; }
      window.location.assign(`/r/${value}`);
    }}>
      <label htmlFor="room-code">Room code</label>
      <input id="room-code" autoFocus required maxLength={64} placeholder="demo" value={roomId} onChange={event => { setRoomId(event.target.value); setError(null); }} aria-describedby={error ? 'room-entry-error' : 'room-entry-hint'} />
      <p id="room-entry-hint" className="settings-hint">Use a shared code, or choose a new one to create a room.</p>
      {error && <p id="room-entry-error" className="join-error" role="alert">{error}</p>}
      <button className="primary-button" disabled={!roomId.trim()}>Join room</button>
    </form>
  </main>;
}
