import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig, loadServerConfig, loadServerEnvironment } from '../src/config.js';
import { boundedHealth } from '../src/app.js';
import { createShutdown } from '../src/shutdown.js';
import { log } from '../src/logger.js';
import { databaseErrorCode } from '../src/db/pool.js';
import { parseServerUrl } from '../../client/src/services/serverUrl.js';

test('production configuration fails closed and never reads local credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'constellate-production-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '.env');
  await writeFile(file, 'DATABASE_URL=local-secret\nCLIENT_ORIGINS=http://localhost:5173\n');
  assert.equal(loadServerEnvironment({ NODE_ENV: 'production' }, file).DATABASE_URL, undefined);
  assert.throws(() => loadServerConfig({ NODE_ENV: 'production' }, file), /CLIENT_ORIGINS is required/);
  for (const origin of ['*', 'null', 'https://*.example.com', 'https://app.example.com/path', 'https://app.example.com/', 'http://app.example.com', 'https://localhost', 'https://u:p@app.example.com']) {
    assert.throws(() => loadServerConfig({ NODE_ENV: 'production', CLIENT_ORIGINS: origin }, file), /CLIENT_ORIGINS/);
  }
  assert.deepEqual(loadServerConfig({ NODE_ENV: 'production', CLIENT_ORIGINS: 'https://app.example.com,https://other.example.com', PORT: '10000' }, file), {
    port: 10000, allowedOrigins: ['https://app.example.com', 'https://other.example.com'],
  });
  assert.equal(loadRuntimeConfig({}).trustProxy, 0);
  for (const env of [{ TRUST_PROXY_HOPS: 'true' }, { SHUTDOWN_TIMEOUT_MS: '-1' }, { HEALTH_TIMEOUT_MS: '0' }, { LOG_LEVEL: 'noisy' }]) {
    assert.throws(() => loadRuntimeConfig(env));
  }
});

test('frontend backend URL permits same origin or explicit HTTPS and rejects mixed content/namespaces', () => {
  assert.equal(parseServerUrl('', true), '');
  assert.equal(parseServerUrl(' https://api.example.com/ ', true), 'https://api.example.com');
  assert.equal(parseServerUrl('http://localhost:3000'), 'http://localhost:3000');
  for (const value of ['http://api.example.com', 'https://localhost:3000', 'wss://api.example.com', '/api', 'https://u:p@api.example.com', 'https://api.example.com/path', 'https://api.example.com?q=1']) {
    assert.throws(() => parseServerUrl(value, true), /VITE_SERVER_URL/);
  }
});

test('Vercel builds the single frontend from the workspace root with SPA routing', async () => {
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.framework, 'vite');
  assert.equal(config.installCommand, 'npm ci --include=dev');
  assert.equal(config.buildCommand, 'npm run build:vercel');
  assert.equal(config.outputDirectory, 'client/dist');
  assert.deepEqual(config.rewrites, [{ source: '/(.*)', destination: '/index.html' }]);
  const checker = fileURLToPath(new URL('../../scripts/check-vercel-env.mjs', import.meta.url));
  const check = (value?: string) => {
    const env = { ...process.env };
    if (value === undefined) delete env.VITE_SERVER_URL;
    else env.VITE_SERVER_URL = value;
    return spawnSync(process.execPath, [checker], { env, encoding: 'utf8' });
  };
  assert.equal(check().status, 1);
  assert.equal(check('http://api.example.com').status, 1);
  assert.equal(check('https://api.example.com/').status, 1);
  assert.equal(check('https://api.example.com').status, 0);
});

test('health checks return bounded failure for rejection and stuck dependencies', async () => {
  assert.equal(await boundedHealth(async () => {}, 20), 'ok');
  assert.equal(await boundedHealth(async () => { throw new Error('private connection details'); }, 20), 'unavailable');
  const start = Date.now();
  assert.equal(await boundedHealth(() => new Promise(() => {}), 20), 'unavailable');
  assert.ok(Date.now() - start < 500);
});

test('shutdown drains accepted work before closing stores, is idempotent and has a deadline', async () => {
  const steps: string[] = [], exits: number[] = [];
  let release!: () => void;
  const shutdown = createShutdown({
    beginDrain: () => { steps.push('drain'); },
    closeConnections: async () => { steps.push('connections'); await new Promise<void>(resolve => { release = resolve; }); },
    closeRuntime: async () => { steps.push('runtime'); },
    closeRedis: () => { steps.push('redis'); },
    closeDatabase: async () => { steps.push('postgres'); },
  }, 25, code => { exits.push(code); });
  const first = shutdown('SIGTERM');
  assert.equal(shutdown('SIGINT'), first);
  assert.deepEqual(steps, ['drain', 'connections']);
  await delay(40);
  assert.deepEqual(exits, [1]);
  release(); await first;
  assert.deepEqual(steps, ['drain', 'connections', 'runtime', 'redis', 'postgres']);
});

test('production logging is JSON, respects levels and only logs safe error codes', t => {
  const previousNode = process.env.NODE_ENV, previousLevel = process.env.LOG_LEVEL;
  t.after(() => {
    if (previousNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNode;
    if (previousLevel === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = previousLevel;
  });
  process.env.NODE_ENV = 'production'; process.env.LOG_LEVEL = 'warn';
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  t.mock.method(console, 'error', (line: string) => { lines.push(line); });
  log('info', 'hidden', 'Hidden.');
  const failure = Object.assign(new Error('postgresql://username:secret@example.com/private'), { code: 'ECONNREFUSED' });
  log('error', 'database.failed', 'Database unavailable.', { code: databaseErrorCode(failure) });
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).code, 'ECONNREFUSED');
  assert.equal(JSON.parse(lines[0]).level, 'error');
  assert.ok(!lines[0].includes('secret'));
});
