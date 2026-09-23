import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import type { RedisConnections } from '../src/redis/connection.js';
import { RedisRateLimiter, requestClientAddress, requestRateKey } from '../src/security/rateLimit.js';

function request(remoteAddress: string, forwarded?: string) {
  return { headers: forwarded ? { 'x-forwarded-for': forwarded } : {}, socket: { remoteAddress } } as unknown as Pick<IncomingMessage, 'headers' | 'socket'>;
}

test('client addresses honor only the configured number of trusted proxies', () => {
  const spoofed = request('10.0.0.4', '198.51.100.8, 203.0.113.9');
  assert.equal(requestClientAddress(spoofed, 0), '10.0.0.4');
  assert.equal(requestClientAddress(spoofed, 1), '203.0.113.9');
  assert.equal(requestClientAddress(spoofed, 2), '198.51.100.8');
  assert.equal(requestClientAddress(request('::ffff:127.0.0.1'), 0), '127.0.0.1');
  assert.equal(requestClientAddress(request('127.0.0.1', 'not-an-address'), 1), '127.0.0.1');
  assert.match(requestRateKey(spoofed, 1), /^[a-f0-9]{32}$/);
  assert.ok(!requestRateKey(spoofed, 1).includes('203.0.113.9'));
});

test('rate limits use scoped expiring Redis keys and fail closed after the limit', async () => {
  const calls: unknown[][] = [];
  let allowed = true;
  const redis = {
    requireReady() {},
    keys: { rate: (scope: string, key: string) => `test:rate:${scope}:${key}` },
    command: { eval: async (...args: unknown[]) => { calls.push(args); return allowed ? 1 : 0; } },
  } as unknown as RedisConnections;
  const limiter = new RedisRateLimiter(redis);
  assert.equal(await limiter.allow('room-create', 'anonymous-key', 10, 60_000), true);
  allowed = false;
  assert.equal(await limiter.allow('room-create', 'anonymous-key', 10, 60_000), false);
  assert.equal(calls[0][1], 1);
  assert.equal(calls[0][2], 'test:rate:room-create:anonymous-key');
  assert.deepEqual(calls[0].slice(3), [10, 60_000]);
});
