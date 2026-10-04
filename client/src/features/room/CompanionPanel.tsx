import { useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, MessageSquare, Users } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import type { MemberPresence, PresenceStatus } from '../../../../shared/presence';
import type { ConnectionStatus } from '../../services/roomConnection';
import type { VoiceControlsState } from '../voice/useVoiceRoom';
import { statusOptions } from '../presence/statusOptions';
import { MembersPanel } from '../presence/MembersPanel';
import { VoiceControls } from '../voice/VoiceControls';
import { RoomChat } from '../chat/RoomChat';
import { ReactionsPanel } from '../reactions/ReactionsPanel';

interface CompanionPanelProps {
  roomId: string;
  members: MemberPresence[];
  currentUserId?: string;
  connection: ConnectionStatus;
  error: string | null;
  statusError: string | null;
  onReconnect: () => void;
  onStatusChange: (status: PresenceStatus) => void;
  onInvite: () => void;
  voice: VoiceControlsState;
}

export function CompanionPanel(props: CompanionPanelProps) {
  const { roomId, members, currentUserId, connection, error, statusError, onReconnect, onStatusChange, voice } = props;
  const [tab, setTab] = useState<'chat' | 'members'>('chat');
  const chatTab = useRef<HTMLButtonElement>(null);
  const membersTab = useRef<HTMLButtonElement>(null);
  const self = members.find(member => member.userId === currentUserId);
  const connectionNote = error ?? (connection === 'waking' ? 'Waking up the study room…' : connection === 'connecting' ? 'Joining the room…' : connection === 'reconnecting' ? 'Reconnecting… keeping your place.' : '');
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'members' : tab === 'chat' ? 'members' : 'chat';
    setTab(next);
    (next === 'chat' ? chatTab : membersTab).current?.focus();
  };

  return <aside className="companion-panel" aria-label="Room companions">
    <div className="companion-tabs" role="tablist" aria-label="Room conversation">
      <button ref={chatTab} id="companion-chat-tab" role="tab" aria-selected={tab === 'chat'} aria-controls="companion-chat" tabIndex={tab === 'chat' ? 0 : -1} onClick={() => setTab('chat')} onKeyDown={navigateTabs}><MessageSquare size={18} />Chat</button>
      <button ref={membersTab} id="companion-members-tab" role="tab" aria-selected={tab === 'members'} aria-controls="companion-members" tabIndex={tab === 'members' ? 0 : -1} onClick={() => setTab('members')} onKeyDown={navigateTabs}><Users size={18} />Members <span className="count-badge">{members.length}</span></button>
    </div>
    <div className="companion-profile">
      {self && <div className="member-row">
        <Avatar avatar={self.avatar} />
        <div className="member-details">
          <div className="member-name">{self.nickname}<span className={`status-dot status-dot--${self.status}`} role="img" aria-label={self.connected ? 'Present' : 'Reconnecting'} /></div>
          <span className={`member-status member-status--${self.status} member-status-control`}>
            <select aria-label="Your status" value={self.status} disabled={connection !== 'connected'} onChange={event => onStatusChange(event.target.value as PresenceStatus)}>
              {statusOptions.map(status => <option key={status.value} value={status.value}>{status.icon} {status.label}</option>)}
            </select><ChevronDown size={12} aria-hidden="true" />
          </span>
        </div>
      </div>}
      {statusError && <p className="presence-status-error" role="status">{statusError}</p>}
      <VoiceControls voice={voice} connection={connection} />
      <div className="companion-connection" role="status" data-connection={connection}>
        {connectionNote}
        {connection === 'error' && <button className="secondary-button" onClick={onReconnect}>Reconnect</button>}
      </div>
    </div>
    <div className="companion-content" id="companion-chat" role="tabpanel" aria-labelledby="companion-chat-tab" hidden={tab !== 'chat'}>
      <RoomChat key={roomId} roomId={roomId} currentUserId={currentUserId} connection={connection} reactions={<ReactionsPanel roomId={roomId} connection={connection} compact />} />
    </div>
    <div className="companion-content" id="companion-members" role="tabpanel" aria-labelledby="companion-members-tab" hidden={tab !== 'members'} tabIndex={0}>
      <MembersPanel {...props} embedded statusError={null} />
    </div>
  </aside>;
}
