import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { requireFreePort, requireLocalTarget, waitForBackend } from '../../scripts/dev.js';
import { connectDependencies } from '../src/startup.js';

test('development preflight rejects occupied ports and mismatched proxy overrides without spawning anything', async t => {
  const server = createServer(); server.listen(0); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await assert.rejects(requireFreePort(port, 'Backend'), /EADDRINUSE.*No new app processes/);
  requireLocalTarget('http://127.0.0.1:3000', 3000, 'proxy');
  requireLocalTarget('http://localhost:3456', 3456, 'proxy');
  for (const url of ['http://127.0.0.1:3001', 'https://localhost:3000', 'http://elsewhere:3000', 'http://localhost:3000/api']) {
    assert.throws(() => requireLocalTarget(url, 3000, 'proxy'), /does not point to the managed backend/);
  }
});

test('frontend gate waits for actual database and Redis readiness, not just an open HTTP port', async t => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(requests < 3 ? 503 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: requests < 3 ? 'unavailable' : 'ok', database: 'ok', redis: requests < 3 ? 'unavailable' : 'ok' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await waitForBackend(url, 3000); assert.equal(requests, 3);
});

test('a missing backend fails the frontend gate and unavailable PostgreSQL produces actionable credential-free output', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await assert.rejects(waitForBackend(`http://127.0.0.1:${port}`, 100), /Vite was not started.*npm run db:start.*npm run redis:start/);
  await assert.rejects(connectDependencies({ DATABASE_URL: `postgresql://private-user:private-password@127.0.0.1:${port}/private-db`, REDIS_URL: 'redis://127.0.0.1:6379' }), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /startup:postgres.*ECONNREFUSED.*npm run db:start/);
    assert.doesNotMatch(error.message, /private-user|private-password|private-db/); return true;
  });
});
