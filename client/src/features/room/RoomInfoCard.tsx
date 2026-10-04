import { Check, Copy, LogOut, Pencil } from 'lucide-react';
import { useState } from 'react';
import type { Room } from '../../types/room';
import type { MemberPresence } from '../../../../shared/presence';

interface RoomInfoCardProps { room: Omit<Room, 'members'> & { members: MemberPresence[] }; onRename: (name: string) => Promise<boolean>; canRename: boolean; error: string | null; onInvite: () => void; copied: boolean; onLeave: () => void; leaving: boolean }

export function RoomInfoCard({ room, onRename, canRename, error, onInvite, copied, onLeave, leaving }: RoomInfoCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.name);
  return (
    <section className="room-info" aria-label="Room information">
      <div className="room-info-main">
        <div className="eyebrow">YOUR SHARED STUDY SPACE</div>
      {editing ? (
        <form className="room-name-form" onSubmit={async event => { event.preventDefault(); if (draft.trim() && await onRename(draft.trim())) setEditing(false); }}>
          <input aria-label="Room name" autoFocus maxLength={32} value={draft} disabled={!canRename} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); }} />
          <button className="icon-button" disabled={!canRename || !draft.trim()} aria-label="Save room name"><Check size={16} /></button>
        </form>
      ) : <div className="room-title-row"><h1>{room.name}</h1><button className="icon-button edit-button" disabled={!canRename} aria-label="Edit room name" onClick={() => { setDraft(room.name); setEditing(true); }}><Pencil size={13} /></button></div>}
      {editing && error && <p className="quest-error" role="status">{error}</p>}
      <div className="room-code">
          <span title={room.code}>{room.code}</span>
          <span className="room-member-count">{room.members.length} in room</span>
        </div>
      </div>
      <div className="room-actions">
        <button className="icon-button" aria-label="Copy room link" onClick={onInvite}>{copied ? <Check size={15} /> : <Copy size={15} />}<span>{copied ? 'Copied' : 'Invite'}</span></button>
        <button className="icon-button leave-room" aria-label="Leave room" title="Leave room" disabled={leaving} onClick={onLeave}><LogOut size={15} /><span>{leaving ? 'Leaving…' : 'Leave'}</span></button>
      </div>
    </section>
  );
}
