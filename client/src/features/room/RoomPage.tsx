import { useEffect, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { Navbar } from '../../components/layout/Navbar';
import { mockRoom } from '../../data/mockRoom';
import { MembersPanel } from '../presence/MembersPanel';
import { getLocalIdentity } from '../presence/localIdentity';
import { useRoomPresence } from '../presence/useRoomPresence';
import { JoinRoomDialog } from '../presence/JoinRoomDialog';
import { ReactionsPanel } from '../reactions/ReactionsPanel';
import { TaskBoard } from '../tasks/TaskBoard';
import { FocusTimer } from '../timer/FocusTimer';
import { EncouragementCard } from './EncouragementCard';
import { RoomInfoCard } from './RoomInfoCard';
import { RoomScene } from './RoomScene';
import { RoomSettings } from './RoomSettings';

export function RoomPage({ roomId }: { roomId: string }) {
  const [identity, setIdentity] = useState(getLocalIdentity);
  const [roomName, setRoomName] = useState(mockRoom.name);
  const { members, connection, error, updateStatus, statusError } = useRoomPresence(roomId, identity);
  const room = { ...mockRoom, id: roomId, name: roomName, code: `r/${roomId}`, members };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dimmed, setDimmed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const roomUrl = new URL(`/room/${roomId}`, window.location.origin).href;

  useEffect(() => { document.title = `${room.name} · Constellate`; }, [room.name]);
  useEffect(() => { if (!copied) return; const timeout = window.setTimeout(() => setCopied(false), 3500); return () => window.clearTimeout(timeout); }, [copied]);
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(roomUrl); setCopied(true); setCopyFallback(false); }
    catch { setCopyFallback(true); }
  };
  return (
    <div className={`app-shell${dimmed ? ' lights-dimmed' : ''}${reducedMotion ? ' reduced-motion' : ''}`}>
      <a href="#room" className="skip-link">Skip to study room</a>
      <Navbar onSettings={() => setSettingsOpen(true)} dimmed={dimmed} onToggleLights={() => setDimmed(!dimmed)} />
      <main className="room-layout">
        <div className="room-column"><div className="space-heading"><span><span aria-hidden="true">✧</span> A SPACE TO FOCUS, TOGETHER</span><span className="space-heading-right">take a breath. you're here.</span></div>
          <RoomScene members={members}><RoomInfoCard room={room} onRename={setRoomName} onInvite={copyLink} copied={copied} /><FocusTimer roomId={roomId} connection={connection} onSettings={() => setSettingsOpen(true)} /><TaskBoard /></RoomScene>
          <div className="room-bottom-caption"><span><span className="status-dot status-dot--coding" />a little company goes a long way</span><span>same stars, different desks <span aria-hidden="true">✦</span></span></div>
        </div>
        <aside className="room-sidebar" aria-label="Room companions"><MembersPanel members={members} currentUserId={identity?.userId} connection={connection} error={error} statusError={statusError} onStatusChange={updateStatus} onInvite={copyLink} /><ReactionsPanel /><EncouragementCard /></aside>
      </main>
      <footer className="app-footer"><span>made for the things you're working toward.</span><span>stay a while <span aria-hidden="true">☾</span></span></footer>
      <RoomSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} reducedMotion={reducedMotion} onMotionChange={setReducedMotion} />
      {!identity && <JoinRoomDialog roomName={room.name} onJoin={setIdentity} />}
      {copied && <div className="toast" role="status"><Check size={17} />Room link copied</div>}
      {copyFallback && <div className="copy-fallback" role="status"><label htmlFor="room-link"><Copy size={16} />Copy this room link</label><input id="room-link" readOnly value={roomUrl} onFocus={(event) => event.target.select()} /><button className="icon-button" aria-label="Close room link" onClick={() => setCopyFallback(false)}><X size={16} /></button></div>}
    </div>
  );
}
