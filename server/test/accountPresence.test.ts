import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountPresenceId, verifyAccountPresence } from '../src/services/accountPresence.js';
import type { AccountVerifier } from '../src/services/supabaseAuth.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const verifier: AccountVerifier = {
  verify: async token => token === 'valid.token' ? { id: accountId, email: 'kei@example.com' } : null,
};

test('account presence IDs are stable, valid room IDs', () => {
  assert.equal(accountPresenceId(accountId), 'account_11111111111141118111111111111111');
  assert.match(accountPresenceId(accountId), /^[a-zA-Z0-9_-]{8,64}$/);
});

test('a verified account token binds the join to its canonical presence ID', async () => {
  const result = await verifyAccountPresence(accountPresenceId(accountId), 'valid.token', verifier);
  assert.equal(result.valid, true);
  assert.equal(result.account?.id, accountId);
});

test('account identity cannot be claimed with the wrong, invalid, or missing token', async () => {
  assert.equal((await verifyAccountPresence(accountPresenceId(accountId), 'valid.token', {
    verify: async () => ({ id: '22222222-2222-4222-8222-222222222222' }),
  })).valid, false);
  assert.equal((await verifyAccountPresence(accountPresenceId(accountId), 'invalid.token', verifier)).valid, false);
  assert.equal((await verifyAccountPresence(accountPresenceId(accountId), undefined, verifier)).valid, false);
});

test('guests remain valid without an account token and cannot attach one', async () => {
  assert.equal((await verifyAccountPresence('guest-user-123', undefined, verifier)).valid, true);
  assert.equal((await verifyAccountPresence('guest-user-123', 'valid.token', verifier)).valid, false);
});
