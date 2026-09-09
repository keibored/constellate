import type { Member } from '../../types/room';
import { Plant } from './RoomDecor';

export function StudyDesk({ member }: { member: Member }) {
  return (
    <div className={`study-desk study-desk--${member.id}`}>
      <div className="desk-member-label"><span className={`status-dot status-dot--${member.status}`} /><strong>{member.name}</strong><span className="desk-status">{member.status}</span></div>
      <div className="desk-art" role="img" aria-label={`${member.name} ${member.status === 'dying' ? 'resting their head on the desk' : member.status === 'reading' ? 'reading a book' : 'working on a laptop'}`}>
        <div className="desk-shadow" /><div className="desk-chair"><span /></div>
        <div className={`character character--${member.id}`}>
          <span className="character-leg leg-left" /><span className="character-leg leg-right" />
          <span className="character-body" />
          <span className="character-arm arm-left" /><span className="character-arm arm-right" />
          <div className="character-head">
            <span className="character-hair" />
            <span className="character-face"><i /><i /></span>
            <span className="character-fringe" />
            {member.id === 'kei' && <span className="character-headphones" />}
          </div>
        </div>
        <div className="desk-leg desk-leg--left" /><div className="desk-leg desk-leg--right" /><div className="desk-brace" />
        <div className="desk-surface" /><div className="desk-front"><span /></div>
        <div className="desk-lamp"><span className="desk-lamp-glow" /><span className="desk-lamp-base" /><span className="desk-lamp-arm" /><span className="desk-lamp-shade" /></div>
        {member.id === 'kei' && <>
          <div className="laptop"><div className="laptop-screen"><i /><i /><i /><i /></div><div className="laptop-base" /></div>
          <Plant className="desk-plant" /><span className="desk-cable" />
        </>}
        {member.id === 'mika' && <>
          <div className="open-book"><i /><i /></div><div className="reading-notebook" />
        </>}
        {member.id === 'ari' && <>
          <div className="desk-notebook" /><span className="tired-cloud">... zZ</span>
        </>}
        <div className="desk-mug"><span /></div><div className="desk-book-stack"><i /><i /></div>
      </div>
      <div className={`desk-progress desk-progress--${member.status}`} role="progressbar" aria-label={`${member.name}'s study progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={member.progress}><span style={{ width: `${member.progress}%` }} /></div>
    </div>
  );
}
