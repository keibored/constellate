import type { MemberPresence } from '../../../../shared/presence';
import { Plant } from './RoomDecor';
import { statusDetails } from '../presence/statusOptions';

export function StudyDesk({ member, slot }: { member?: MemberPresence; slot: 0 | 1 | 2 }) {
  const deskStyle = member ? member.status === 'reading' ? 'mika' : member.status === 'dying' ? 'ari' : 'kei' : ['kei', 'mika', 'ari'][slot];
  const status = member ? statusDetails[member.status] : null;
  return (
    <div className={`study-desk study-desk--slot-${slot} study-desk--${deskStyle}${member ? '' : ' study-desk--empty'}${member?.status === 'break' ? ' study-desk--break' : ''}`} data-user-id={member?.userId} data-desk-id={`desk-${slot + 1}`}>
      <div className="desk-member-label">{member && status ? <><span className={`status-dot status-dot--${member.status}`} /><strong>{member.nickname}</strong><span className="desk-status"><span aria-hidden="true">{status.icon}</span> {status.label}</span></> : <span>empty desk</span>}</div>
      <div className="desk-art" role="img" aria-label={member && status ? `${member.nickname} ${status.activity}` : 'An empty study desk'}>
        <div className="desk-shadow" /><div className="desk-chair"><span /></div>
        {member && <div className={`character character--${deskStyle} character-avatar--${member.avatar}${member.status === 'break' ? ' character--break' : ''}`}>
          <span className="character-leg leg-left" /><span className="character-leg leg-right" />
          <span className="character-body" />
          <span className="character-arm arm-left" /><span className="character-arm arm-right" />
          <div className="character-head">
            <span className="character-hair" />
            <span className="character-face"><i /><i /></span>
            <span className="character-fringe" />
            {member.status === 'coding' && <span className="character-headphones" />}
          </div>
        </div>}
        <div className="desk-leg desk-leg--left" /><div className="desk-leg desk-leg--right" /><div className="desk-brace" />
        <div className="desk-surface" /><div className="desk-front"><span /></div>
        <div className="desk-lamp"><span className="desk-lamp-glow" /><span className="desk-lamp-base" /><span className="desk-lamp-arm" /><span className="desk-lamp-shade" /></div>
        {deskStyle === 'kei' && <>
          <div className="laptop"><div className="laptop-screen"><i /><i /><i /><i /></div><div className="laptop-base" /></div>
          <Plant className="desk-plant" /><span className="desk-cable" />
        </>}
        {deskStyle === 'mika' && <>
          <div className="open-book"><i /><i /></div><div className="reading-notebook" />
        </>}
        {deskStyle === 'ari' && <>
          <div className="desk-notebook" />{member?.status === 'dying' && <span className="tired-cloud">... zZ</span>}
        </>}
        <div className="desk-mug"><span /></div><div className="desk-book-stack"><i /><i /></div>
      </div>
      <div className={`desk-progress desk-progress--${member?.status ?? 'empty'}`} aria-hidden="true"><span style={{ width: member ? '100%' : 0 }} /></div>
    </div>
  );
}
