import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { webcrypto } from 'node:crypto';
import { getGuestUserId, getLocalIdentity, saveLocalIdentity, IDENTITY_STORAGE_KEY, USER_ID_STORAGE_KEY } from '../../client/src/features/presence/localIdentity.js';

function storage(t: TestContext) {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  return values;
}

test('first opening creates a persistent guest ID before the profile is completed; refresh and tabs reuse it', t => {
  const values = storage(t);
  assert.equal(getLocalIdentity(), null);
  const userId = values.get(USER_ID_STORAGE_KEY);
  assert.match(userId!, /^[a-zA-Z0-9_-]{8,64}$/);
  assert.equal(getGuestUserId(), userId);
  const identity = saveLocalIdentity('  kei  ', 'dark');
  assert.deepEqual(identity, { userId, nickname: 'kei', avatar: 'dark' });
  assert.deepEqual(getLocalIdentity(), identity);
  assert.equal(saveLocalIdentity('new nickname', 'green').userId, userId);
});

test('existing profiles migrate without changing their identity, name, or avatar', t => {
  const values = storage(t);
  const old = { userId: 'existing-user-kei', nickname: 'kei', avatar: 'pink' };
  values.set(IDENTITY_STORAGE_KEY, JSON.stringify(old));
  assert.deepEqual(getLocalIdentity(), old);
  assert.equal(values.get(USER_ID_STORAGE_KEY), old.userId);
});

test('malformed profiles recover and insecure origins can generate an ID without randomUUID', t => {
  const values = storage(t);
  values.set(IDENTITY_STORAGE_KEY, '{broken');
  values.set(USER_ID_STORAGE_KEY, 'invalid!');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', previous));
  assert.equal(getLocalIdentity(), null);
  const id = getGuestUserId();
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(saveLocalIdentity('guest', 'green').userId, id);
  assert.throws(() => saveLocalIdentity('  ', 'dark'));
});
