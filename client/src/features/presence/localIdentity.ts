import type { AvatarId } from '../../../../shared/presence';

export interface LocalIdentity {
  userId: string;
  nickname: string;
  avatar: AvatarId;
}

export const IDENTITY_STORAGE_KEY = 'constellate.identity';

export function getLocalIdentity(): LocalIdentity | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(IDENTITY_STORAGE_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const identity = value as Record<string, unknown>;
    if (typeof identity.userId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(identity.userId)) return null;
    if (typeof identity.nickname !== 'string' || !isNickname(identity.nickname)) return null;
    if (identity.avatar !== 'dark' && identity.avatar !== 'pink' && identity.avatar !== 'green') return null;
    return { userId: identity.userId, nickname: identity.nickname.trim(), avatar: identity.avatar };
  } catch { return null; }
}

export function isNickname(nickname: string) {
  return nickname.trim().length > 0 && nickname.trim().length <= 24 && !/[\u0000-\u001f\u007f]/.test(nickname);
}

export function saveLocalIdentity(nickname: string, avatar: AvatarId): LocalIdentity {
  if (!isNickname(nickname)) throw new Error('Choose a nickname with 1–24 characters.');
  const identity = { userId: getLocalIdentity()?.userId ?? crypto.randomUUID(), nickname: nickname.trim(), avatar };
  localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  return identity;
}
