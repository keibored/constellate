import type { ReactNode } from 'react';
import { Moon, Sparkles } from 'lucide-react';
import type { MemberPresence } from '../../../../shared/presence';
import { RoomDecor } from './RoomDecor';
import { StudyDesk } from './StudyDesk';

export function RoomScene({ members, children }: { members: MemberPresence[]; children: ReactNode }) {
  return (
    <section className="room-scene" id="room" aria-label="Cozy nighttime study room">
      <RoomDecor />
      <div className="room-scene-caption"><Moon size={12} /><span>MOONLIT LIBRARY</span><span className="caption-line" /></div>
      <div className="desk-stations">{([0, 1, 2] as const).map(slot => <StudyDesk key={slot} slot={slot} member={members[slot]} />)}</div>
      {children}
      <div className="room-floor-message"><Sparkles size={15} /><span>you're doing great.</span></div>
      <span className="scene-corner-star" aria-hidden="true">✧</span>
    </section>
  );
}
