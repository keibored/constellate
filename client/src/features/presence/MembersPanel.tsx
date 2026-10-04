import { ChevronDown, Mic, MicOff, Plus, Users } from 'lucide-react';
import { VoiceControls } from '../voice/VoiceControls';
import type { VoiceControlsState } from '../voice/useVoiceRoom';
import { Avatar } from '../../components/ui/Avatar';
import type { MemberPresence, PresenceStatus } from '../../../../shared/presence';
import type { ConnectionStatus } from './useRoomPresence';
import { statusDetails, statusOptions } from './statusOptions';

interface MembersPanelProps {
  members: MemberPresence[];
  currentUserId?: string;
  connection: ConnectionStatus;
  error: string | null;
  statusError: string | null;
  onStatusChange: (status: PresenceStatus) => void;
  onInvite: () => void;
  onReconnect: () => void;
  voice?: VoiceControlsState;
  embedded?: boolean;
}

export function MembersPanel({ members, currentUserId, connection, error, statusError, onStatusChange, onInvite, onReconnect, voice, embedded = false }: MembersPanelProps) {
  const message = error ?? (connection === 'waking' ? 'Waking up the study room…' : connection === 'connecting' ? 'Joining the room…' : connection === 'reconnecting' ? 'Reconnecting… keeping your place.' : '');
  return (
    <section className="sidebar-panel members-panel" id="members" aria-labelledby={embedded ? 'companion-members-tab' : 'members-heading'}>
      {!embedded && <div className="panel-heading"><h2 id="members-heading"><Users size={16} />Members <span className="count-badge">{members.length}</span></h2><span className="panel-sparkle" aria-hidden="true">✧</span></div>}
      <div className={`member-list${members.length > 3 ? ' member-list--many' : ''}`}>
        {members.map(member => <div className="member-row" key={member.userId} data-user-id={member.userId}>
          <Avatar avatar={member.avatar} />
          <div className="member-details">
            <div className="member-name"><span>{member.nickname}</span>{member.userId === currentUserId && <span className="you-label">you</span>}</div>
            {member.userId === currentUserId && !embedded ? <span className={`member-status member-status--${member.status} member-status-control`}>
              <select aria-label="Your status" value={member.status} disabled={connection !== 'connected'} onChange={event => onStatusChange(event.target.value as PresenceStatus)}>
                {statusOptions.map(status => <option key={status.value} value={status.value}>{status.icon} {status.label}</option>)}
              </select><ChevronDown size={11} aria-hidden="true" />
            </span> : <span className={`member-status member-status--${member.status}`}><span className="member-status-icon" aria-hidden="true">{statusDetails[member.status].icon}</span>{statusDetails[member.status].label}</span>}
          </div>
          {voice?.participants.some(participant => participant.guestId === member.userId) && <span className="member-voice" role="img" aria-label={voice.participants.find(participant => participant.guestId === member.userId)?.muted ? 'In voice, muted' : 'In voice, microphone on'}>{voice.participants.find(participant => participant.guestId === member.userId)?.muted ? <MicOff size={13} /> : <Mic size={13} />}</span>}
          <span className={`status-dot status-dot--${member.status}`} aria-label={member.connected ? 'Present' : 'Reconnecting'} role="img" />
        </div>)}
        {!members.length && <p className="presence-empty">A quiet room. Make yourself at home.</p>}
      </div>
      {statusError && <p className="presence-status-error" role="status">{statusError}</p>}
      {!embedded && connection === 'error' && <button className="invite-button" onClick={onReconnect}>Reconnect</button>}
      {voice && !embedded && <VoiceControls voice={voice} connection={connection} />}
      {!embedded && <button className="invite-button" onClick={onInvite}><Plus size={15} />Invite friends</button>}
      {!embedded && <p className="panel-footnote presence-connection" role="status" data-connection={connection}>{message || "there's always room for one more"}</p>}
    </section>
  );
}
