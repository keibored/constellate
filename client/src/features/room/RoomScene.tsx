import { Moon, Sparkles, Radio } from 'lucide-react';
import type { MemberPresence } from '../../../../shared/presence';
import { RoomDecor } from './RoomDecor';
import { StudyDesk } from './StudyDesk';

export function RoomScene({ members, onRadioOpen, radioOpen = false }: { members: MemberPresence[]; onRadioOpen?: () => void; radioOpen?: boolean }) {
  return (
    <section className="room-scene" id="room" aria-label="Cozy nighttime study room">
      <RoomDecor />
      {onRadioOpen && <button className="scene-radio" aria-label="Open room radio" aria-expanded={radioOpen} aria-controls="room-radio-panel" onClick={onRadioOpen}><Radio size={28} /><span>Room radio</span></button>}
      <div className="room-scene-caption"><Moon size={12} /><span>MOONLIT LIBRARY</span><span className="caption-line" /></div>
      <div className="desk-stations">{([0, 1, 2] as const).map(slot => <StudyDesk key={slot} slot={slot} member={members.find(member => member.deskId === `desk-${slot + 1}`)} />)}</div>
      <div className="room-floor-message"><Sparkles size={15} /><span>you're doing great.</span></div>
      <span className="scene-corner-star" aria-hidden="true">✧</span>
    </section>
  );
}
