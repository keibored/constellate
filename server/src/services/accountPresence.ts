import type { AccountIdentity, AccountVerifier } from './supabaseAuth.js';

const ACCOUNT_PREFIX = 'account_';

export function accountPresenceId(accountId: string) {
  return `${ACCOUNT_PREFIX}${accountId.replaceAll('-', '').toLowerCase()}`;
}

export async function verifyAccountPresence(
  claimedUserId: string,
  token: unknown,
  verifier?: AccountVerifier,
): Promise<{ account: AccountIdentity | null; valid: boolean }> {
  const claimsAccountIdentity = claimedUserId.startsWith(ACCOUNT_PREFIX);
  if (typeof token !== 'string') return { account: null, valid: !claimsAccountIdentity };
  const account = verifier ? await verifier.verify(token) : null;
  return { account, valid: Boolean(account && claimedUserId === accountPresenceId(account.id)) };
}
