import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { RedisConnections } from '../redis/connection.js';

const consume = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if current >= limit then return 0 end
current = redis.call('INCR', KEYS[1])
if current == 1 or redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
if current > limit then return 0 end
return 1`;

export type RateLimitScope = 'handshake' | 'room-join' | 'room-create';

function normalizeAddress(value: string | undefined) {
  if (!value) return 'unknown';
  let address = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(address);
  if (bracketed) address = bracketed[1];
  else if (ipv4WithPort) address = ipv4WithPort[1];
  if (address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  return isIP(address) ? address.toLowerCase() : 'unknown';
}

/** Select the first untrusted address from the right, matching Express's numeric trust-proxy behavior. */
export function requestClientAddress(request: Pick<IncomingMessage, 'headers' | 'socket'>, trustedProxyHops = 0) {
  const peer = normalizeAddress(request.socket.remoteAddress);
  if (trustedProxyHops <= 0) return peer;
  const header = request.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(value => normalizeAddress(value));
  if (!forwarded.length || forwarded.every(value => value === 'unknown')) return peer;
  const chain = [...forwarded, peer];
  const candidate = chain[Math.max(0, chain.length - 1 - trustedProxyHops)];
  return candidate === 'unknown' ? peer : candidate;
}

/** Redis keys contain only a one-way identifier, never a visitor's raw network address. */
export function requestRateKey(request: Pick<IncomingMessage, 'headers' | 'socket'>, trustedProxyHops = 0) {
  return createHash('sha256').update(requestClientAddress(request, trustedProxyHops)).digest('hex').slice(0, 32);
}

/** A fixed-window limit shared by every backend instance through Redis. */
export class RedisRateLimiter {
  constructor(private readonly redis: RedisConnections) {}

  async allow(scope: RateLimitScope, clientKey: string, limit: number, windowMs: number) {
    this.redis.requireReady();
    const result = await this.redis.command.eval(consume, 1, this.redis.keys.rate(scope, clientKey), limit, windowMs);
    return Number(result) === 1;
  }
}
