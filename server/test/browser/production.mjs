import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { chromium } from 'playwright';
import { io } from 'socket.io-client';
import { loadServerEnvironment } from '../../dist/config.js';
import { createDatabasePool } from '../../dist/db/pool.js';
import { RedisConnections } from '../../dist/redis/connection.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const remote = process.argv.includes('--remote');
const runId = randomBytes(8).toString('hex');
const report = { mode: remote ? 'deployed' : 'local-production-https', checks: [], errors: [], limitations: [
  'Synthetic microphone audio only; physical devices and restrictive-network TURN remain manual checks.',
] };
const cleanup = [], nodes = [], proxySockets = new Set();
let browser, admin, pool, redis, targetPort, frontendUrl, backendUrl, probeUrl;
const schema = `constellate_test_${runId}`, prefix = `constellate:production-test:${runId}`;
const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!await check()) { assert.ok(Date.now() < end, label); await delay(80); }
}
async function freePort() {
  const server = createNetServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function run(args, env, cwd = root, executable = process.execPath) {
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit'); return { code, output };
}
function readApi(path, headers = {}, method = 'GET') {
  if (remote) return fetch(`${backendUrl}${path}`, { headers, method, signal: AbortSignal.timeout(10000) }).then(async response => ({ status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() }));
  return new Promise((resolve, reject) => {
    // Only this self-signed, loopback test proxy bypasses certificate validation.
    const request = httpsRequest(`${probeUrl}${path}`, { rejectUnauthorized: false, headers, method }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.setTimeout(10000, () => request.destroy(new Error('API probe timeout')));
    request.on('error', reject); request.end();
  });
}
async function listen(server, port) {
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => {
    for (const socket of proxySockets) socket.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
}
async function stop(node, graceful = true) {
  if (node.child.exitCode !== null || node.child.signalCode !== null) return;
  const done = once(node.child, 'exit');
  if (graceful && node.child.connected) node.child.send('test:SIGTERM'); else node.child.kill();
  const deadline = setTimeout(() => node.child.kill(), 28000);
  const [code] = await done; clearTimeout(deadline);
  if (graceful) {
    assert.equal(code, 0, node.logs);
    assert.ok(node.logs.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).some(line => line.event === 'server.shutdown_complete'));
  }
}
try {
  await mkdir(`${root}/.vite`, { recursive: true });
  // Generated tone only. No real microphone is accessed or recorded.
  const samples = 48000 * 10, tone = Buffer.alloc(44 + samples * 2);
  tone.write('RIFF'); tone.writeUInt32LE(tone.length - 8, 4); tone.write('WAVEfmt ', 8); tone.writeUInt32LE(16, 16);
  tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22); tone.writeUInt32LE(48000, 24); tone.writeUInt32LE(96000, 28);
  tone.writeUInt16LE(2, 32); tone.writeUInt16LE(16, 34); tone.write('data', 36); tone.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) tone.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 6000), 44 + i * 2);
  const tonePath = `${root}/.vite/production-tone.wav`; await writeFile(tonePath, tone);
  if (remote) {
    frontendUrl = process.env.FRONTEND_URL; backendUrl = process.env.BACKEND_URL;
    for (const url of [frontendUrl, backendUrl]) assert.ok(url && new URL(url).protocol === 'https:' && new URL(url).origin === url, 'Set FRONTEND_URL and BACKEND_URL to exact deployed HTTPS origins.');
    report.limitations.push('Remote test does not restart hosted services or inspect migration tables; verify deployment logs and perform a controlled redeploy separately.');
  } else {
    const env = loadServerEnvironment(); assert.ok(env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL for an isolated test schema.'); assert.ok(env.REDIS_URL);
    assert.notEqual(env.TEST_DATABASE_URL, env.DATABASE_URL, 'Use a separate test database.');
    admin = createDatabasePool(env.TEST_DATABASE_URL); await admin.query(`CREATE SCHEMA "${schema}"`);
    const database = new URL(env.TEST_DATABASE_URL); database.searchParams.set('options', `-c search_path=${schema}`);
    pool = createDatabasePool(database.href); redis = new RedisConnections(env.REDIS_URL, prefix); await redis.connect();
    const frontendPort = await freePort(), apiPort = await freePort();
    frontendUrl = `https://app.constellate.test:${frontendPort}`; backendUrl = `https://api.constellate.test:${apiPort}`; probeUrl = `https://127.0.0.1:${apiPort}`;
    const productionEnv = { NODE_ENV: 'production', DATABASE_URL: database.href, REDIS_URL: env.REDIS_URL, REDIS_KEY_PREFIX: prefix,
      CLIENT_ORIGINS: frontendUrl, TRUST_PROXY_HOPS: '1', LOG_LEVEL: 'info', HOST: '127.0.0.1' };
    const missing = await run(['server/dist/index.js'], { ...productionEnv, PORT: String(await freePort()) });
    assert.equal(missing.code, 1); assert.match(missing.output, /schema is missing/);
    pass('production startup refuses to listen with missing migrations');
    const migrations = await Promise.all([1, 2].map(() => run(['server/dist/db/migrate.js'], productionEnv)));
    assert.ok(migrations.every(result => result.code === 0), JSON.stringify(migrations));
    assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '3');
    assert.equal((await run(['server/dist/db/migrate.js'], productionEnv)).code, 0);
    pass('compiled release migrations succeed concurrently and repeat without reapplying');
    const openssl = process.env.OPENSSL_BIN || (existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
    const certFile = `${root}/.vite/production-cert.pem`, keyFile = `${root}/.vite/production-key.pem`;
    const cert = await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=*.constellate.test', '-addext', 'subjectAltName=DNS:*.constellate.test'], {}, root, openssl);
    assert.equal(cert.code, 0, cert.output);
    const tls = { key: await readFile(keyFile), cert: await readFile(certFile) };
    const built = await run([`${root}/node_modules/vite/bin/vite.js`, 'build', '--outDir', `${root}/.vite/production-client`, '--emptyOutDir'],
      { NODE_ENV: 'production', VITE_SERVER_URL: backendUrl, VITE_ICE_SERVERS: '[]' }, `${root}/client`);
    assert.equal(built.code, 0, built.output);
    for (let i = 0; i < 2; i++) {
      const node = { port: await freePort(), logs: '' };
      node.child = spawn(process.execPath, ['server/test/helpers/production-process.mjs'], { cwd: root, windowsHide: true,
        env: { ...process.env, ...productionEnv, PORT: String(node.port) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      node.child.stdout.on('data', chunk => { node.logs += chunk; }); node.child.stderr.on('data', chunk => { node.logs += chunk; }); nodes.push(node);
      await until(async () => {
        assert.equal(node.child.exitCode, null, node.logs);
        return fetch(`http://127.0.0.1:${node.port}/api/ready`).then(r => r.ok, () => false);
      }, 'production backend ready');
    }
    targetPort = nodes[0].port;
    const proxy = createHttpsServer(tls, (request, response) => {
      const upstream = httpRequest({ host: '127.0.0.1', port: targetPort, path: request.url, method: request.method,
        headers: { ...request.headers, 'x-forwarded-proto': 'https' } }, received => {
        response.writeHead(received.statusCode, received.headers); received.pipe(response);
      });
      upstream.on('error', () => { response.writeHead(503); response.end(); }); request.pipe(upstream);
    });
    proxy.on('upgrade', (request, socket, head) => {
      proxySockets.add(socket); socket.on('close', () => proxySockets.delete(socket)); socket.on('error', () => {});
      const upstream = httpRequest({ host: '127.0.0.1', port: targetPort, path: request.url, headers: request.headers });
      upstream.on('upgrade', (response, peer, receivedHead) => {
        proxySockets.add(peer); peer.on('close', () => proxySockets.delete(peer)); peer.on('error', () => socket.destroy());
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
        if (head.length) peer.write(head); if (receivedHead.length) socket.write(receivedHead);
        socket.pipe(peer).pipe(socket); socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
      });
      upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); response.resume(); });
      upstream.on('error', () => socket.destroy()); upstream.end();
    });
    await listen(proxy, apiPort);
    const staticApp = express();
    staticApp.use((_request, response, next) => { response.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()'); next(); });
    staticApp.use(express.static(`${root}/.vite/production-client`));
    staticApp.get('*', (_request, response) => response.sendFile(`${root}/.vite/production-client/index.html`));
    await listen(createHttpsServer(tls, staticApp), frontendPort);
    pass('built React assets and two production Node processes run behind separate HTTPS/WSS origins');
  }
  const publicHealth = await readApi('/api/health'); assert.equal(publicHealth.status, 200);
  assert.deepEqual(JSON.parse(publicHealth.text), { status: 'ok', server: 'ok', database: 'ok', redis: 'ok' });
  const ready = await readApi('/api/ready'); assert.equal(ready.status, 200);
  assert.deepEqual(JSON.parse(ready.text), { status: 'ok', server: 'ok', database: 'ok', redis: 'ok' });
  assert.equal(ready.headers['cache-control'], 'no-store');
  assert.equal((await readApi('/api/ready', { Origin: 'https://untrusted.example' })).status, 403);
  const cors = await readApi('/api/stats/me', { Origin: frontendUrl, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }, 'OPTIONS');
  assert.equal(cors.status, 204); assert.equal(cors.headers['access-control-allow-origin'], frontendUrl);
  assert.equal((await readApi('/api/stats/me')).status, 401);
  const denied = io(remote ? backendUrl : probeUrl, { autoConnect: false, transports: ['websocket'], reconnection: false, timeout: 3000,
    extraHeaders: { Origin: 'https://untrusted.example' }, ...(remote ? {} : { rejectUnauthorized: false }) });
  try {
    const accepted = await new Promise(resolve => {
      denied.once('connect', () => resolve(true)); denied.once('connect_error', () => resolve(false)); denied.connect();
    });
    assert.equal(accepted, false, 'An untrusted WebSocket origin must be rejected.');
  } finally { denied.close(); }
  pass('health verifies PostgreSQL and all Redis connections; CORS preflight succeeds and hostile HTTP/WSS origins are rejected');
  browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${tonePath}`, ...(remote ? [] : ['--host-resolver-rules=MAP *.constellate.test 127.0.0.1', '--no-proxy-server'])] });
  const contexts = await Promise.all([1, 2].map(() => browser.newContext({ ignoreHTTPSErrors: !remote })));
  const room = `deploy-check-${runId}`, sockets = [];
  for (const context of contexts) await context.addInitScript(() => {
    window.__productionTest = { calls: 0, pcs: [], streams: [] };
    const media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.__productionTest.calls++; const stream = await media(constraints); window.__productionTest.streams.push(stream); return stream;
    };
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original { constructor(config) { super(config); window.__productionTest.pcs.push(this); } };
  });
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const connected = page => page.locator('[data-connection="connected"]').waitFor({ timeout: 60000 });
  for (const [i, page] of pages.entries()) {
    // Put the second guest on another node to exercise Redis fanout over WSS.
    if (!remote && i === 1) targetPort = nodes[1].port;
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('websocket', socket => sockets.push(socket.url()));
    await page.goto(`${frontendUrl}/r/${room}`);
    await page.getByLabel('Nickname', { exact: true }).fill(`Deploy Check ${i + 1}`);
    await page.getByRole('button', { name: 'Join room', exact: true }).click(); await connected(page);
    assert.ok(await page.evaluate(() => isSecureContext && location.protocol === 'https:' && !!navigator.mediaDevices));
    assert.equal(await page.evaluate(() => window.__productionTest.calls), 0);
  }
  assert.ok(sockets.length >= 2 && sockets.every(url => url.startsWith('wss:') && url.includes('transport=websocket')));
  const [a, b] = pages;
  await a.getByLabel('Message', { exact: true }).fill(`Production ${runId}`); await a.getByRole('button', { name: 'Send message', exact: true }).click();
  await b.getByText(`Production ${runId}`, { exact: true }).waitFor();
  pass('deep links load the built app; two isolated guests join over WSS and chat without automatic microphone capture');
  // Exercise the HTTP base URL with a real UI statistics request and bearer preflight.
  const statsResponse = a.waitForResponse(response => response.url().startsWith(`${backendUrl}/api/stats/me?`) && response.status() === 200);
  await a.getByRole('link', { name: 'Stats', exact: true }).click();
  await statsResponse;
  await a.getByRole('link', { name: 'Room', exact: true }).click();
  pass('statistics use the separate HTTPS backend and authorize through CORS');
  const state = page => page.evaluate(async () => {
    let energy = 0;
    const pcs = window.__productionTest.pcs.filter(pc => pc.connectionState !== 'closed');
    for (const pc of pcs) for (const entry of (await pc.getStats()).values()) if (entry.type === 'inbound-rtp' && entry.kind === 'audio') energy += entry.totalAudioEnergy ?? 0;
    return { calls: window.__productionTest.calls, energy, peers: pcs.filter(pc => pc.connectionState === 'connected').length,
      live: window.__productionTest.streams.flatMap(s => s.getTracks()).filter(t => t.readyState === 'live').length };
  });
  for (const page of pages) { await page.getByRole('button', { name: 'Join Voice', exact: true }).click(); await page.locator('[data-voice-state="joined"]').waitFor(); }
  await until(async () => (await Promise.all(pages.map(state))).every(s => s.peers === 1 && s.energy > 0), 'HTTPS bidirectional synthetic audio');
  pass('explicit Join Voice obtains a synthetic microphone stream over HTTPS with bidirectional decoded WebRTC audio');
  await a.getByRole('button', { name: 'Start', exact: true }).click();
  await a.getByRole('button', { name: 'Add task', exact: true }).click();
  await a.getByLabel('New task', { exact: true }).fill(`Deploy task ${runId}`);
  await a.locator('.add-task-form').getByRole('button', { name: 'Add', exact: true }).click();
  await b.getByLabel(`Deploy task ${runId}`, { exact: true }).waitFor();
  const before = await Promise.all(pages.map(state));
  const beforeRuntime = redis ? JSON.parse(await redis.command.hget(redis.keys.room(room), 'state')) : null;
  if (!remote) {
    targetPort = nodes[1].port;
    await stop(nodes[0]);
    pass('SIGTERM closes transport connections, drains work, closes stores and exits cleanly with JSON logs');
  } else {
    await contexts[0].setOffline(true);
    await a.locator('[data-connection="reconnecting"]').waitFor({ timeout: 60000 });
    await contexts[0].setOffline(false);
  }
  for (const page of pages) await connected(page);
  await until(async () => (await Promise.all(pages.map(state))).every(s => s.peers === 1 && s.energy > 0), 'voice recovers after reconnect');
  assert.deepEqual((await Promise.all(pages.map(state))).map(s => s.calls), before.map(s => s.calls));
  if (redis) {
    const restored = JSON.parse(await redis.command.hget(redis.keys.room(room), 'state'));
    assert.equal(restored.timer.endsAt, beforeRuntime.timer.endsAt, 'Reconnect must preserve the exact server deadline.');
    assert.equal(Object.keys(restored.presence).length, 2, 'Reconnect must not duplicate guests.');
  }
  for (const page of pages) {
    await page.getByLabel(`Deploy task ${runId}`, { exact: true }).waitFor();
    await page.getByText(`Production ${runId}`, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  }
  pass('automatic reconnect restores saved tasks, chat, running timer and voice without reacquiring the microphone');
  await a.reload(); await connected(a);
  assert.equal((await state(a)).calls, 0);
  await a.getByLabel(`Deploy task ${runId}`, { exact: true }).waitFor();
  pass('refresh restores persistent room state without automatically capturing a microphone');
  for (const page of pages) { await page.getByLabel('Leave room', { exact: true }).click(); await page.waitForURL('**/join'); assert.equal((await state(page)).live, 0); }
  assert.deepEqual(report.errors, []);
  if (remote) report.limitations.push(`Verification created room ${room} with two synthetic guests, one task and one chat message; normal retention applies.`);
} catch (error) { report.errors.push(error.stack ?? String(error)); console.error(error); process.exitCode = 1; }
finally {
  const clean = async close => { try { await close(); } catch (error) { report.errors.push(`Cleanup: ${error.message}`); process.exitCode = 1; } };
  await clean(() => browser?.close());
  for (const node of nodes) await clean(() => stop(node));
  for (const close of cleanup.reverse()) await clean(close);
  if (redis) {
    await clean(async () => { const keys = await redis.command.keys(`${prefix}:*`); if (keys.length) await redis.command.del(...keys); });
    redis.close();
  }
  await clean(() => pool?.end());
  if (admin) {
    await clean(async () => { assert.match(schema, /^constellate_test_[a-f0-9]{16}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); });
    await clean(() => admin.end());
  }
  await writeFile(`${root}/.vite/production-report.json`, JSON.stringify(report, null, 2));
}
