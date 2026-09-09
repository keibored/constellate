import type { MemberId } from '../../types/room';

interface AvatarProps { memberId: MemberId; small?: boolean; labelled?: boolean }

export function Avatar({ memberId, small = false, labelled = false }: AvatarProps) {
  return (
    <span className={`avatar avatar--${memberId}${small ? ' avatar--small' : ''}`}
      role={labelled ? 'img' : undefined} aria-label={labelled ? memberId : undefined}
      aria-hidden={labelled ? undefined : true}>
      <span className="avatar-hair" /><span className="avatar-face" /><span className="avatar-shirt" />
    </span>
  );
}
