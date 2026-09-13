import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { getGuestUserId, getLocalIdentity, saveLocalIdentity, USER_ID_STORAGE_KEY } from '../../client/src/features/presence/localIdentity.js';
import { forgetRoom, getLastRoom, getRoomStatus, rememberRoom, rememberStatus, LAST_ROOM_STORAGE_KEY, STATUS_STORAGE_KEY } from '../../client/src/features/presence/localSession.js';

function storage(t: TestContext) {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  return values;
}

test('leaving clears only the active room and preserves guest/profile/status; another tab room is not cleared', t => {
  const values = storage(t);
  const guest = saveLocalIdentity('kei', 'pink');
  assert.match(guest.userId, /^[a-f0-9-]{36}$/);
  rememberRoom('demo');
  rememberStatus(guest.userId, 'demo', 'reading');
  assert.equal(getLastRoom(), 'demo');
  forgetRoom('demo');
  assert.equal(getLastRoom(), null);
  assert.equal(values.has(LAST_ROOM_STORAGE_KEY), false);
  assert.equal(values.get(USER_ID_STORAGE_KEY), guest.userId);
  assert.deepEqual(getLocalIdentity(), guest);
  assert.equal(getRoomStatus(guest.userId, 'demo'), 'reading');
  rememberRoom('other-room'); forgetRoom('demo');
  assert.equal(getLastRoom(), 'other-room');
});

test('saved statuses are room/guest scoped, reread after another tab writes, and malformed storage is ignored', t => {
  const values = storage(t);
  rememberStatus('guest-user', 'demo', 'break');
  rememberStatus('guest-user', 'other-room', 'writing');
  assert.equal(getRoomStatus('guest-user', 'demo'), 'break');
  assert.equal(getRoomStatus('guest-user', 'other-room'), 'writing');
  assert.equal(getRoomStatus('another-user', 'demo'), 'coding');
  values.set(STATUS_STORAGE_KEY, JSON.stringify({ userId: 'guest-user', rooms: { demo: 'reading', 'invalid!': 'break', other: 'fake' } }));
  assert.equal(getRoomStatus('guest-user', 'demo'), 'reading');
  assert.equal(getRoomStatus('guest-user', 'other'), 'coding');
  assert.equal(getRoomStatus('guest-user', 'toString'), 'coding');
  values.set(STATUS_STORAGE_KEY, '{broken');
  assert.equal(getRoomStatus('guest-user', 'demo'), 'coding');
  for (const invalid of ['../bad', 'https://example.com', '', 'a'.repeat(65)]) {
    values.set(LAST_ROOM_STORAGE_KEY, invalid);
    assert.equal(getLastRoom(), null);
  }
});

test('blocked browser storage keeps one usable identity within the tab without crashing', t => {
  storage(t);
  const guest = saveLocalIdentity('kei', 'dark');
  t.mock.method(localStorage, 'getItem', () => { throw new Error('blocked'); });
  t.mock.method(localStorage, 'setItem', () => { throw new Error('blocked'); });
  t.mock.method(localStorage, 'removeItem', () => { throw new Error('blocked'); });
  assert.equal(getGuestUserId(), guest.userId);
  assert.deepEqual(getLocalIdentity(), guest);
  rememberRoom('demo');
  assert.equal(getLastRoom(), 'demo');
  forgetRoom('demo');
  assert.equal(getLastRoom(), null);
});
