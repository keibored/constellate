import { ChevronDown, Plus, Users } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import type { MemberPresence, PresenceStatus } from '../../../../shared/presence';
import type { ConnectionStatus } from './useRoomPresence';

interface MembersPanelProps {
  members: MemberPresence[];
  currentUserId?: string;
  connection: ConnectionStatus;
  error: string | null;
  statusError: string | null;
  onStatusChange: (status: PresenceStatus) => void;
  onInvite: () => void;
}

export function MembersPanel({ members, currentUserId, connection, error, statusError, onStatusChange, onInvite }: MembersPanelProps) {
  const message = error ?? (connection === 'connecting' ? 'Joining the room…' : connection === 'reconnecting' ? 'Reconnecting… keeping your place.' : '');
  return (
    <section className="sidebar-panel members-panel" id="members" aria-labelledby="members-heading">
      <div className="panel-heading"><h2 id="members-heading"><Users size={16} />Members <span className="count-badge">{members.length}</span></h2><span className="panel-sparkle" aria-hidden="true">✧</span></div>
      <div className={`member-list${members.length > 3 ? ' member-list--many' : ''}`}>
        {members.map(member => <div className="member-row" key={member.userId} data-user-id={member.userId}>
          <Avatar avatar={member.avatar} />
          <div className="member-details">
            <div className="member-name"><span>{member.nickname}</span>{member.userId === currentUserId && <span className="you-label">you</span>}</div>
            {member.userId === currentUserId ? <span className={`member-status member-status--${member.status} member-status-control`}>
              <select aria-label="Your status" value={member.status} disabled={connection !== 'connected'} onChange={event => onStatusChange(event.target.value as PresenceStatus)}>
                <option value="coding">coding</option><option value="reading">reading</option><option value="break">break</option><option value="dying">dying</option>
              </select><ChevronDown size={11} aria-hidden="true" />
            </span> : <span className={`member-status member-status--${member.status}`}>{member.status}{member.status === 'dying' && <span aria-hidden="true"> ...</span>}</span>}
          </div>
          <span className={`status-dot status-dot--${member.status}`} aria-label="Present" role="img" />
        </div>)}
        {!members.length && <p className="presence-empty">A quiet room. Make yourself at home.</p>}
      </div>
      {statusError && <p className="presence-status-error" role="status">{statusError}</p>}
      <button className="invite-button" onClick={onInvite}><Plus size={15} />Invite friends</button>
      <p className="panel-footnote presence-connection" role="status" data-connection={connection}>{message || "there's always room for one more"}</p>
    </section>
  );
}
