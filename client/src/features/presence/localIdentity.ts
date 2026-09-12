import type { AvatarId } from '../../../../shared/presence';

export interface LocalIdentity {
  userId: string;
  nickname: string;
  avatar: AvatarId;
}

export const IDENTITY_STORAGE_KEY = 'constellate.identity';
export const USER_ID_STORAGE_KEY = 'constellate_user_id';
const isUserId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value);

export function getGuestUserId(): string {
  let previous: unknown;
  try { previous = JSON.parse(localStorage.getItem(IDENTITY_STORAGE_KEY) ?? 'null')?.userId; }
  catch { /* A malformed profile should not prevent creating a guest. */ }
  const saved = localStorage.getItem(USER_ID_STORAGE_KEY);
  // Keep existing profiles intact. getRandomValues also works on LAN HTTP origins
  // where randomUUID is unavailable because the page is not a secure context.
  const userId = isUserId(previous) ? previous : isUserId(saved) ? saved
    : typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(USER_ID_STORAGE_KEY, userId);
  return userId;
}

export function getLocalIdentity(): LocalIdentity | null {
  try {
    getGuestUserId();
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
  const identity = { userId: getGuestUserId(), nickname: nickname.trim(), avatar };
  localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  return identity;
}
