import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForBackend } from '../../client/src/services/backendWarmup.js';

const health = (status: number, body: object) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('backend warm-up retries an unavailable response until health is ready', async () => {
  const requests: string[] = [];
  let attempt = 0;
  const ready = await waitForBackend({
    fetcher: async input => {
      requests.push(String(input));
      attempt++;
      return attempt === 1 ? health(503, { status: 'unavailable' }) : health(200, { status: 'ok' });
    },
    deadlineMs: 100,
    retryMs: 0,
    delay: async () => {},
  });
  assert.equal(ready, true);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(url => url.endsWith('/api/health')));
});

test('backend warm-up has a deadline and lets Socket.IO remain the fallback', async () => {
  let now = 0;
  let requests = 0;
  const ready = await waitForBackend({
    fetcher: async () => { requests++; return health(503, { status: 'unavailable' }); },
    deadlineMs: 25,
    retryMs: 10,
    now: () => now,
    delay: async milliseconds => { now += milliseconds; },
  });
  assert.equal(ready, false);
  assert.equal(now, 25);
  assert.equal(requests, 3);
});
