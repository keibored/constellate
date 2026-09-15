import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { loadServerEnvironment, loadServerConfig } from '../../dist/config.js';
import { createDatabasePool } from '../../dist/db/pool.js';
import { migrate } from '../../dist/db/migrations.js';
import { RedisConnections } from '../../dist/redis/connection.js';

// Exercise the actual documented npm command and real configured ports, not a
// replacement Vite/server fixture. Refuse occupied ports; never kill user processes.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = loadServerEnvironment(), { port } = loadServerConfig(env);
assert.ok(env.TEST_DATABASE_URL); assert.ok(env.REDIS_URL); assert.ok(process.env.npm_execpath);
const frontend = 'http://localhost:5173', backend = `http://127.0.0.1:${port}`;
async function free(port = 0) {
  const probe = createServer(); probe.listen(port); await once(probe, 'listening');
  const chosen = probe.address().port; await new Promise(resolve => probe.close(resolve)); return chosen;
}
await free(port); await free(5173);
const unavailable = await free();
const suffix = randomBytes(8).toString('hex'), schema = `constellate_test_${suffix}`, prefix = `constellate:devtest:${suffix}`;
const admin = createDatabasePool(env.TEST_DATABASE_URL); await admin.query(`CREATE SCHEMA "${schema}"`);
const database = new URL(env.TEST_DATABASE_URL); database.searchParams.set('options', `-c search_path=${schema}`);
const pool = createDatabasePool(database.href), redis = new RedisConnections(env.REDIS_URL, prefix);
const report = { checks: [], errors: [] }, processes = [];
let browser, app;
const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!await fn()) { assert.ok(Date.now() < deadline, label); await delay(100); }
}
function launch(overrides = {}) {
  const run = { output: '', child: undefined };
  run.child = spawn(process.execPath, [process.env.npm_execpath, 'run', 'dev'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: database.href, REDIS_URL: env.REDIS_URL, REDIS_KEY_PREFIX: prefix, PORT: String(port), FORCE_COLOR: '0', ...overrides } });
  const collect = chunk => { run.output += String(chunk); process.stdout.write(chunk); };
  run.child.stdout.on('data', collect); run.child.stderr.on('data', collect); processes.push(run);
  return run;
}
async function stop(run) {
  if (!run?.child || run.child.exitCode !== null || run.child.signalCode !== null) return;
  const exited = once(run.child, 'exit');
  if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true }, resolve));
  else run.child.kill('SIGTERM');
  await exited;
}
const rootExit = run => until(() => run.child.exitCode !== null, 'root dev should fail promptly', 15000);
try {
  await migrate(pool); await redis.connect();
  const pgFailure = launch({ DATABASE_URL: `postgresql://unused:unused@127.0.0.1:${unavailable}/unused` });
  await rootExit(pgFailure); assert.notEqual(pgFailure.child.exitCode, 0);
  assert.match(pgFailure.output, /startup:postgres.*ECONNREFUSED.*npm run db:start/); assert.doesNotMatch(pgFailure.output, /Starting Vite|VITE v/);
  const redisFailure = launch({ REDIS_URL: `redis://127.0.0.1:${unavailable}` });
  await rootExit(redisFailure); assert.notEqual(redisFailure.child.exitCode, 0);
  assert.match(redisFailure.output, /startup:redis.*npm run redis:start/); assert.doesNotMatch(redisFailure.output, /Starting Vite|VITE v/);
  pass('unavailable PostgreSQL or Redis fails root startup with an actionable error before any frontend starts');

  app = launch();
  await until(async () => {
    assert.equal(app.child.exitCode, null, app.output);
    return fetch(`${frontend}/api/ready`).then(response => response.ok, () => false);
  }, 'documented root command starts a ready app');
  assert.ok(app.output.indexOf('Server running at') < app.output.indexOf('Starting Vite.'));
  assert.doesNotMatch(app.output, /ECONNREFUSED|http proxy error/);
  pass('TEST 1: npm run dev starts backend before Vite; API readiness succeeds with no refused proxy connections');
  const duplicate = launch(); await rootExit(duplicate);
  assert.notEqual(duplicate.child.exitCode, 0); assert.match(duplicate.output, /port .*unavailable.*No new app processes/);
  pass('a duplicate npm run dev is rejected while the original app stays healthy');

  browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const contexts = await Promise.all([1, 2].map(() => browser.newContext()));
  for (const context of contexts) await context.addInitScript(() => {
    window.__devTest = { peers: [], mediaRequests: 0, timer: null };
    const originalMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => { window.__devTest.mediaRequests++; return originalMedia(constraints); };
    const OriginalPeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OriginalPeer { constructor(config) { super(config); window.__devTest.peers.push(this); } };
  });
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const [index, page] of pages.entries()) {
    page.on('pageerror', error => report.errors.push(error.message)); page.setDefaultTimeout(15000);
    await page.goto(`${frontend}/r/startup-check`);
    await page.getByLabel('Nickname', { exact: true }).fill(index ? 'Startup Mika' : 'Startup Kei');
    await page.getByRole('button', { name: 'Join room', exact: true }).click();
    await page.locator('[data-connection="connected"]').waitFor();
    await page.evaluate(async () => {
      const { roomSocket } = await import('/src/services/socket.ts');
      roomSocket.on('timer:state', state => { window.__devTest.timer = state; });
      await roomSocket.timeout(5000).emitWithAck('timer:sync', { roomId: 'startup-check' });
    });
  }
  const [a, b] = pages;
  const twoMembers = () => Promise.all(pages.map(page => page.locator('.member-row').count())).then(counts => counts.every(count => count === 2));
  await until(twoMembers, 'two isolated browser identities appear');
  for (const page of pages) assert.equal(await page.evaluate(() => window.__devTest.mediaRequests), 0);
  pass('TESTS 2–3: frontend Socket.IO connects through Vite and two isolated browser identities share realtime presence');
  await a.getByLabel('Message', { exact: true }).fill('Startup verified'); await a.getByRole('button', { name: 'Send message', exact: true }).click();
  await b.getByText('Startup verified', { exact: true }).waitFor();
  await a.getByLabel('Send a star', { exact: true }).click(); await until(async () => await b.locator('[data-reaction-id]').count() === 1, 'reaction');
  await a.getByRole('button', { name: 'Add task', exact: true }).click(); await a.getByLabel('New task', { exact: true }).fill('Verify startup');
  await a.locator('.add-task-form').getByRole('button', { name: 'Add', exact: true }).click();
  await b.getByLabel('Verify startup', { exact: true }).check(); await until(() => a.getByLabel('Verify startup', { exact: true }).isChecked(), 'shared task completion');
  pass('TEST 4: chat, reactions and task changes synchronize');
  await a.getByRole('button', { name: 'Start', exact: true }).click();
  await until(async () => (await Promise.all(pages.map(page => page.evaluate(() => window.__devTest.timer?.status)))).every(status => status === 'running'), 'shared timer starts');
  const deadline = await a.evaluate(() => window.__devTest.timer.endsAt);
  assert.equal(await b.evaluate(() => window.__devTest.timer.endsAt), deadline);
  pass('TEST 5: both browsers share the same authoritative Pomodoro deadline');
  for (const page of pages) { await page.getByRole('button', { name: 'Join Voice', exact: true }).click(); await page.locator('[data-voice-state="joined"]').waitFor(); }
  const mesh = () => Promise.all(pages.map(page => page.evaluate(() => window.__devTest.peers.filter(peer => peer.connectionState !== 'closed').map(peer => peer.connectionState)))).then(states => states.every(state => state.length === 1 && state[0] === 'connected'));
  await until(mesh, 'voice peers connected');
  pass('TEST 6: two browser identities establish real WebRTC peers through room-scoped signaling');
  assert.doesNotMatch(app.output, /ECONNREFUSED|http proxy error/);
  const pid = Number([...app.output.matchAll(/\[startup:http\] Listening on port \d+ \(PID (\d+)\)/g)].at(-1)?.[1]); assert.ok(pid);
  const outageStart = app.output.length;
  process.kill(pid); // Only the backend child of this test's root command; watcher and Vite remain alive.
  for (const page of pages) await page.locator('[data-connection="reconnecting"]').waitFor();
  pass('TEST 7: intentional backend stop shows client reconnecting (proxy refusal during the stop is expected and remains visible)');
  await delay(1200); app.child.stdin.write('\n'); // concurrently routes Enter to the existing tsx watcher, no second server.
  for (const page of pages) await page.locator('[data-connection="connected"]').waitFor();
  await until(twoMembers, 'reconnect without duplicate guests'); await until(mesh, 'voice restores without duplicate peers');
  for (const page of pages) {
    assert.equal(await page.evaluate(() => window.__devTest.mediaRequests), 1);
    assert.equal(await page.evaluate(() => window.__devTest.timer.endsAt), deadline);
  }
  await delay(500); const recoveryStart = app.output.length;
  await a.getByLabel('Message', { exact: true }).fill('After restart'); await a.getByRole('button', { name: 'Send message', exact: true }).click();
  await b.getByText('After restart', { exact: true }).waitFor(); await delay(1500);
  assert.doesNotMatch(app.output.slice(recoveryStart), /ECONNREFUSED|http proxy error/);
  report.intentionalOutageLogged = /ECONNREFUSED|http proxy error/.test(app.output.slice(outageStart, recoveryStart));
  const socketCounts = await Promise.all(pages.map(page => page.evaluate(async () => {
    const { roomSocket } = await import('/src/services/socket.ts'); return { connected: roomSocket.connected, transport: roomSocket.io.engine.transport.name };
  })));
  assert.deepEqual(socketCounts, [{ connected: true, transport: 'websocket' }, { connected: true, transport: 'websocket' }]);
  // The killed process cannot remove its leases immediately; they expire safely.
  await delay(46_000);
  await a.evaluate(async () => { const { roomSocket } = await import('/src/services/socket.ts'); await roomSocket.timeout(5000).emitWithAck('timer:sync', { roomId: 'startup-check' }); });
  const settled = JSON.parse(await redis.command.hget(redis.keys.room('startup-check'), 'state'));
  assert.equal(Object.keys(settled.presence).length, 2);
  assert.equal(Object.values(settled.presence).flatMap(guest => Object.keys(guest.sockets)).length, 2);
  assert.equal(Object.keys(settled.voice).length, 2);
  pass('TEST 8: same watcher restarts backend; both guests, voice and timer recover; old leases expire to exactly two active sockets');
  assert.deepEqual(report.errors, []);
} catch (error) { report.errors.push(error.stack); console.error(error); process.exitCode = 1; }
finally {
  await browser?.close(); for (const run of processes.reverse()) await stop(run);
  await mkdir(`${root}/.vite`, { recursive: true });
  await writeFile(`${root}/.vite/dev-startup-report.json`, JSON.stringify(report, null, 2));
  await writeFile(`${root}/.vite/dev-startup.log`, app?.output ?? 'Startup test did not reach app launch.');
  if (redis.ready) { const keys = await redis.command.keys(`${prefix}:*`); if (keys.length) await redis.command.del(...keys); }
  redis.close(); await pool.end(); assert.match(schema, /^constellate_test_[a-f0-9]{16}$/);
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
}
