import { useEffect, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { Navbar } from '../../components/layout/Navbar';
import { mockRoom } from '../../data/mockRoom';
import { getLocalIdentity } from '../presence/localIdentity';
import { useRoomPresence } from '../presence/useRoomPresence';
import { JoinRoomDialog } from '../presence/JoinRoomDialog';
import { TaskBoard } from '../tasks/TaskBoard';
import { useRoomState } from '../tasks/useRoomState';
import { FocusTimer } from '../timer/FocusTimer';
import { RoomInfoCard } from './RoomInfoCard';
import { RoomRadioArea } from '../radio/RoomRadio';
import { CompanionPanel } from './CompanionPanel';
import { RoomSettings } from './RoomSettings';
import { StatsView } from '../stats/StatsView';
import { useVoiceRoom } from '../voice/useVoiceRoom';
import '../../styles/voice.css';
import { useAuth } from '../auth/AuthProvider';
import { getAccountProfile, saveAccountProfile } from '../../services/accountProfile';
import { saveLocalIdentity } from '../presence/localIdentity';
import type { AvatarId } from '../../../../shared/presence';
import { AccountProfileGate } from '../presence/AccountProfileGate';
import { guestStorage } from '../../services/localStorage';

const ROOM_PREFERENCES_KEY = 'constellate:room-preferences';

function loadRoomPreferences() {
  try {
    const saved = JSON.parse(guestStorage.get(ROOM_PREFERENCES_KEY) ?? '{}') as { dimmed?: unknown; reducedMotion?: unknown };
    return { dimmed: saved.dimmed === true, reducedMotion: saved.reducedMotion === true };
  } catch {
    return { dimmed: false, reducedMotion: false };
  }
}

export function RoomPage({ roomId }: { roomId: string }) {
  const { session, loading: authLoading } = useAuth();
  const [identity, setIdentity] = useState<ReturnType<typeof getLocalIdentity>>(null);
  const [identityLoading, setIdentityLoading] = useState(true);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [profileAttempt, setProfileAttempt] = useState(0);
  useEffect(() => {
    if (authLoading) return;
    let active = true;
    setIdentityLoading(true); setIdentityError(null); setIdentity(null);
    if (!session) {
      setIdentity(getLocalIdentity()); setIdentityLoading(false);
      return () => { active = false; };
    }
    void getAccountProfile().then(profile => {
      if (active) setIdentity(profile ? { userId: session.user.id, nickname: profile.nickname, avatar: profile.avatar } : null);
    }).catch(reason => {
      if (active) setIdentityError(reason instanceof Error ? reason.message : 'Check your connection and try again.');
    }).finally(() => { if (active) setIdentityLoading(false); });
    return () => { active = false; };
  }, [authLoading, session?.user.id, profileAttempt]);
  const saveProfile = async (nickname: string, avatar: AvatarId) => {
    if (session) {
      const profile = await saveAccountProfile(nickname, avatar);
      setIdentity({ userId: session.user.id, nickname: profile.nickname, avatar: profile.avatar });
    } else setIdentity(saveLocalIdentity(nickname, avatar));
  };
  const [statsOpen, setStatsOpen] = useState(() => window.location.hash === '#stats');
  useEffect(() => {
    const navigate = () => { setStatsOpen(window.location.hash === '#stats'); };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  useEffect(() => {
    if (!statsOpen && ['#room', '#quests', '#members'].includes(window.location.hash)) {
      document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
    }
  }, [statsOpen]);
  const { members, connection, error, reconnect, leave, updateStatus, statusError, currentUserId } = useRoomPresence(roomId, identity);
  const voice = useVoiceRoom(roomId, currentUserId, connection);
  const [leaving, setLeaving] = useState(false);
  const leaveRoom = async () => {
    if (leaving) return;
    setLeaving(true);
    await voice.leave();
    await leave();
    window.location.assign('/');
  };
  const savedRoom = useRoomState(roomId, connection);
  const room = { ...mockRoom, id: roomId, name: savedRoom.state?.room.name ?? mockRoom.name, code: `r/${roomId}`, members };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [roomPreferences] = useState(loadRoomPreferences);
  const [dimmed, setDimmed] = useState(roomPreferences.dimmed);
  const [reducedMotion, setReducedMotion] = useState(roomPreferences.reducedMotion);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const roomUrl = new URL(`/?room=${encodeURIComponent(roomId)}`, window.location.origin).href;

  useEffect(() => { document.title = `${room.name} · Constellate`; }, [room.name]);
  useEffect(() => {
    guestStorage.set(ROOM_PREFERENCES_KEY, JSON.stringify({ dimmed, reducedMotion }));
  }, [dimmed, reducedMotion]);
  useEffect(() => { if (!copied) return; const timeout = window.setTimeout(() => setCopied(false), 3500); return () => window.clearTimeout(timeout); }, [copied]);
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(roomUrl); setCopied(true); setCopyFallback(false); }
    catch { setCopyFallback(true); }
  };
  return (
    <div className={`app-shell study-workspace${dimmed ? ' lights-dimmed' : ''}${reducedMotion ? ' reduced-motion' : ''}`}>
      <a href={statsOpen ? '#stats' : '#room'} className="skip-link">Skip to study {statsOpen ? 'stats' : 'room'}</a>
      <Navbar onSettings={() => setSettingsOpen(true)} dimmed={dimmed} onToggleLights={() => setDimmed(!dimmed)} onHome={() => { void leaveRoom(); }} statsOpen={statsOpen} />
      <main className="room-layout" hidden={statsOpen}>
        <RoomInfoCard room={room} onRename={savedRoom.rename} canRename={savedRoom.ready && !savedRoom.saving} error={savedRoom.error} onInvite={copyLink} copied={copied} onLeave={() => { void leaveRoom(); }} leaving={leaving} />
        <div className="room-column">
          <FocusTimer roomId={roomId} connection={connection} onSettings={() => setSettingsOpen(true)} />
          <RoomRadioArea roomId={roomId} connection={connection} currentUserId={currentUserId} members={members} />
          <TaskBoard key={roomId} tasks={savedRoom.state?.tasks ?? []} ready={savedRoom.ready} saving={savedRoom.saving} error={savedRoom.error} onCreate={savedRoom.createTask} onToggle={savedRoom.toggleTask} onDelete={savedRoom.deleteTask} onSync={savedRoom.sync} />
        </div>
        <CompanionPanel key={roomId} roomId={roomId} voice={voice} members={members} currentUserId={currentUserId} connection={connection} error={error} onReconnect={reconnect} statusError={statusError} onStatusChange={updateStatus} onInvite={copyLink} />
      </main>
      {statsOpen && <StatsView key={roomId} roomId={roomId} connection={connection} />}
      <footer className="app-footer"><span>made for the things you're working toward.</span><span>stay a while <span aria-hidden="true">☾</span></span></footer>
      <RoomSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} reducedMotion={reducedMotion} onMotionChange={setReducedMotion} identity={identity} accountProfile={Boolean(session)} onProfileSave={saveProfile} />
      <AccountProfileGate loading={identityLoading} error={identityError} onRetry={() => setProfileAttempt(attempt => attempt + 1)} />
      {!identityLoading && !identityError && !identity && <JoinRoomDialog roomName={room.name} account={Boolean(session)} onJoin={saveProfile} />}
      {copied && <div className="toast" role="status"><Check size={17} />Room link copied</div>}
      {copyFallback && <div className="copy-fallback" role="status"><label htmlFor="room-link"><Copy size={16} />Copy this room link</label><input id="room-link" readOnly value={roomUrl} onFocus={(event) => event.target.select()} /><button className="icon-button" aria-label="Close room link" onClick={() => setCopyFallback(false)}><X size={16} /></button></div>}
    </div>
  );
}
