import { Check, Copy, LogOut, Pencil, Users } from 'lucide-react';
import { useState } from 'react';
import type { Room } from '../../types/room';
import type { MemberPresence } from '../../../../shared/presence';

interface RoomInfoCardProps { room: Omit<Room, 'members'> & { members: MemberPresence[] }; onRename: (name: string) => Promise<boolean>; canRename: boolean; error: string | null; onInvite: () => void; copied: boolean; onLeave: () => void; leaving: boolean }

export function RoomInfoCard({ room, onRename, canRename, error, onInvite, copied, onLeave, leaving }: RoomInfoCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.name);
  return (
    <section className="room-info" aria-label="Room information">
      <div className="eyebrow"><span className="tiny-star">✦</span> OUR LITTLE CORNER</div>
      {editing ? (
        <form className="room-name-form" onSubmit={async event => { event.preventDefault(); if (draft.trim() && await onRename(draft.trim())) setEditing(false); }}>
          <input aria-label="Room name" autoFocus maxLength={32} value={draft} disabled={!canRename} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); }} />
          <button className="icon-button" disabled={!canRename || !draft.trim()} aria-label="Save room name"><Check size={16} /></button>
        </form>
      ) : <div className="flex items-center gap-2"><h1>{room.name}</h1><button className="icon-button edit-button" disabled={!canRename} aria-label="Edit room name" onClick={() => { setDraft(room.name); setEditing(true); }}><Pencil size={13} /></button></div>}
      {editing && error && <p className="quest-error" role="status">{error}</p>}
      <div className="room-code"><span title={room.code}>{room.code}</span><button className="icon-button" aria-label="Copy room link" onClick={onInvite}>{copied ? <Check size={13} /> : <Copy size={13} />}</button><button className="icon-button leave-room" aria-label="Leave room" title="Leave room" disabled={leaving} onClick={onLeave}><LogOut size={13} /></button></div>
      <div className="room-count"><span className="status-dot status-dot--coding" /><Users size={13} /><span>{room.members.length} in room</span><span className="room-divider" /><span>all together</span></div>
      <p className="room-motto">{room.motto}</p>
    </section>
  );
}
