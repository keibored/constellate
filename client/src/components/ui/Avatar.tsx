import type { MemberId } from '../../types/room';
import type { AvatarId } from '../../../../shared/presence';

interface AvatarProps { memberId?: MemberId; avatar?: AvatarId; label?: string; small?: boolean; labelled?: boolean }
const avatarStyles: Record<AvatarId, MemberId> = { dark: 'kei', pink: 'mika', green: 'ari' };

export function Avatar({ memberId, avatar, label, small = false, labelled = false }: AvatarProps) {
  const style = avatar ? avatarStyles[avatar] : memberId ?? 'kei';
  return (
    <span className={`avatar avatar--${style}${small ? ' avatar--small' : ''}`}
      role={labelled ? 'img' : undefined} aria-label={labelled ? label ?? memberId ?? avatar : undefined}
      aria-hidden={labelled ? undefined : true}>
      <span className="avatar-hair" /><span className="avatar-face" /><span className="avatar-shirt" />
    </span>
  );
}
