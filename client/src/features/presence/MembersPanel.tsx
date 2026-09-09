import { Plus, Users } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import type { Member } from '../../types/room';

export function MembersPanel({ members, onInvite }: { members: Member[]; onInvite: () => void }) {
  return (
    <section className="sidebar-panel members-panel" id="members" aria-labelledby="members-heading">
      <div className="panel-heading"><h2 id="members-heading"><Users size={16} />Members <span className="count-badge">{members.length}</span></h2><span className="panel-sparkle" aria-hidden="true">✧</span></div>
      <div className="member-list">{members.map((member) => <div className="member-row" key={member.id}><Avatar memberId={member.id} /><div className="member-details"><div className="member-name">{member.name}{member.id === 'kei' && <span className="you-label">you</span>}</div><span className={`member-status member-status--${member.status}`}>{member.status}{member.status === 'dying' && <span className="tired-dots" aria-hidden="true"> ...</span>}</span></div><span className={`status-dot status-dot--${member.status}`} /></div>)}</div>
      <button className="invite-button" onClick={onInvite}><Plus size={15} />Invite friends</button><p className="panel-footnote">there's always room for one more</p>
    </section>
  );
}
