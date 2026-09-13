import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadServerConfig } from '../src/config.js';

test('backend defaults, environment precedence and exact origin allowlists', t => {
  const directory = mkdtempSync(join(tmpdir(), 'constellate-config-'));
  const envFile = join(directory, '.env');
  t.after(() => {
    if (existsSync(envFile)) unlinkSync(envFile);
    rmdirSync(directory);
  });
  assert.deepEqual(loadServerConfig({}, envFile), {
    port: 3000,
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  });
  writeFileSync(envFile, 'PORT=4321\nCLIENT_ORIGINS=https://study.example.com\n');
  const environment = { PORT: '4567' };
  assert.equal(loadServerConfig({}, envFile).port, 4321);
  assert.deepEqual(loadServerConfig(environment, envFile), {
    port: 4567, allowedOrigins: ['https://study.example.com'],
  });
  assert.deepEqual(environment, { PORT: '4567' }, 'loading config must not mutate Vite/process environment');
  assert.deepEqual(loadServerConfig({ CLIENT_ORIGINS: '' }, envFile).allowedOrigins, []);
  for (const PORT of ['invalid', '0', '-1', '65536', '3000.5']) {
    assert.throws(() => loadServerConfig({ PORT }, envFile), /PORT must be an integer/);
  }
});
