import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createServer as createViteServer, createLogger } from 'vite';
import { loadServerEnvironment } from '../../dist/config.js';
import { createDatabasePool } from '../../dist/db/pool.js';
import { migrate } from '../../dist/db/migrations.js';
import { RedisConnections } from '../../dist/redis/connection.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = loadServerEnvironment(); assert.ok(env.TEST_DATABASE_URL); assert.ok(env.REDIS_URL);
const suffix = randomBytes(8).toString('hex'), schema = `constellate_test_${suffix}`, prefix = `constellate:browser:${suffix}`;
const admin = createDatabasePool(env.TEST_DATABASE_URL); await admin.query(`CREATE SCHEMA "${schema}"`);
const database = new URL(env.TEST_DATABASE_URL); database.searchParams.set('options', `-c search_path=${schema}`);
const pool = createDatabasePool(database.href), redis = new RedisConnections(env.REDIS_URL, prefix);
await redis.connect();
const report = { checks: [], errors: [] }, nodes = [], vites = [];
let browser;
async function until(fn, label, timeout = 25000) { const end = Date.now() + timeout; while (!await fn()) { assert.ok(Date.now() < end, label); await delay(50); } }
const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
async function freePort() { const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; }
async function start(node) {
  node.child = spawn(process.execPath, [`${root}/server/dist/index.js`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: database.href, REDIS_URL: env.REDIS_URL, REDIS_KEY_PREFIX: prefix, PORT: String(node.port), CLIENT_ORIGINS: nodes.map(item => item.origin).join(',') } });
  node.child.stdout.on('data', () => {}); node.child.stderr.on('data', data => { node.logs += String(data); });
  await until(() => { assert.equal(node.child.exitCode, null, node.logs); return fetch(`http://127.0.0.1:${node.port}/api/ready`).then(response => response.ok, () => false); }, 'backend ready');
  node.up = true;
}
async function stop(node) { node.up = false; if (node.child && node.child.exitCode === null && node.child.signalCode === null) { const exited = once(node.child, 'exit'); node.child.kill(); await exited; } }
try {
  await migrate(pool); await mkdir(`${root}/.vite`, { recursive: true });
  // Generated test tone only: this test never captures or records a real microphone.
  const samples = 48000 * 10, tone = Buffer.alloc(44 + samples * 2);
  tone.write('RIFF'); tone.writeUInt32LE(tone.length - 8, 4); tone.write('WAVEfmt ', 8); tone.writeUInt32LE(16, 16);
  tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22); tone.writeUInt32LE(48000, 24); tone.writeUInt32LE(96000, 28); tone.writeUInt16LE(2, 32); tone.writeUInt16LE(16, 34);
  tone.write('data', 36); tone.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) tone.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 6000), 44 + i * 2);
  const tonePath = `${root}/.vite/voice-test-tone.wav`; await writeFile(tonePath, tone);
  process.chdir(`${root}/client`); process.env.SERVER_PROXY_TARGET = ''; process.env.VITE_ICE_SERVERS = '[]';
  for (let i = 0; i < 2; i++) {
    const node = { port: await freePort(), up: false, logs: '', origin: '' }; nodes.push(node); process.env.PORT = String(node.port);
    const logger = createLogger('silent'); logger.error = message => { if (node.up && !/socket hang up|ECONNRESET/.test(message)) report.errors.push(String(message)); };
    const vite = await createViteServer({ root: `${root}/client`, configFile: `${root}/client/vite.config.ts`, server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null }, customLogger: logger });
    await vite.listen(); vites.push(vite); node.origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  }
  await Promise.all(nodes.map(start));
  browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${tonePath}`] });
  const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext({ viewport: { width: 1366, height: 1000 } })));
  for (const context of contexts) await context.addInitScript(() => {
    window.__voiceTest = { permissionCalls: 0, streams: [], pcs: [] };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { window.__voiceTest.permissionCalls++; const stream = await getUserMedia(constraints); window.__voiceTest.streams.push(stream); return stream; };
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Original { constructor(config) { super(config); window.__voiceTest.pcs.push(this); } };
  });
  const page = async context => { const result = await context.newPage(); result.setDefaultTimeout(15000); result.on('pageerror', error => report.errors.push(error.message)); return result; };
  const a = await page(contexts[0]), b = await page(contexts[1]), c = await page(contexts[2]), d = await page(contexts[3]);
  const ready = p => p.locator('[data-connection="connected"]').waitFor();
  async function join(p, origin, nickname, room = 'voice-study') {
    await p.goto(`${origin}/r/${room}`);
    if (await p.getByLabel('Nickname', { exact: true }).count()) { await p.getByLabel('Nickname', { exact: true }).fill(nickname); await p.getByRole('button', { name: 'Join room', exact: true }).click(); }
    await ready(p);
  }
  const state = p => p.evaluate(async () => {
    const pcs = window.__voiceTest.pcs.filter(pc => pc.connectionState !== 'closed');
    let energy = 0, bytes = 0;
    for (const pc of pcs) for (const item of (await pc.getStats()).values()) if (item.type === 'inbound-rtp' && item.kind === 'audio') { energy += item.totalAudioEnergy ?? 0; bytes += item.bytesReceived ?? 0; }
    return { permissionCalls: window.__voiceTest.permissionCalls, active: pcs.length, connected: pcs.filter(pc => pc.connectionState === 'connected').length,
      tracks: window.__voiceTest.streams.flatMap(stream => stream.getTracks().map(track => ({ enabled: track.enabled, readyState: track.readyState, kind: track.kind }))),
      outputs: [...document.querySelectorAll('audio[data-voice-peer]')].map(audio => ({ paused: audio.paused, hasStream: Boolean(audio.srcObject) })), energy, bytes };
  });
  const mesh = async (pages, peers) => { await until(async () => (await Promise.all(pages.map(state))).every(s => s.active === peers && s.connected === peers && s.outputs.length === peers), `${peers}-peer WebRTC mesh`); };
  const voice = async p => { await p.getByRole('button', { name: 'Join Voice', exact: true }).click(); await p.locator('[data-voice-state="joined"]').waitFor(); };
  await join(a, nodes[0].origin, 'Voice Kei'); await join(b, nodes[1].origin, 'Voice Mika');
  assert.equal((await state(a)).permissionCalls, 0); assert.equal((await state(b)).permissionCalls, 0);
  pass('two real Node processes and Vite proxies join the same room without requesting a microphone');
  await voice(a); assert.equal((await state(a)).permissionCalls, 1); await voice(b); await mesh([a, b], 1);
  for (const p of [a, b]) if (await p.getByRole('button', { name: 'Enable audio', exact: true }).count()) await p.getByRole('button', { name: 'Enable audio', exact: true }).click();
  await until(async () => (await state(a)).energy > 0 && (await state(b)).energy > 0, 'bidirectional decoded audio');
  assert.ok((await state(a)).outputs.every(output => !output.paused && output.hasStream));
  assert.ok((await state(b)).outputs.every(output => !output.paused && output.hasStream));
  pass('explicit Join Voice creates one peer/output each, with bidirectional received audio bytes and decoded energy');
  await a.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await b.getByLabel('In voice, muted', { exact: true }).waitFor(); await delay(1200);
  const mutedEnergy = (await state(b)).energy; await delay(700); assert.ok((await state(b)).energy - mutedEnergy < 0.0001);
  assert.ok((await state(a)).tracks.filter(track => track.readyState === 'live').every(track => !track.enabled));
  await a.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  await until(async () => (await state(b)).energy > mutedEnergy + 0.0001, 'unmuted audio'); await mesh([a, b], 1);
  pass('mute silences the synthetic audio and updates peer presence; unmute resumes the same peer connection');
  const tab = await page(contexts[0]); await join(tab, nodes[0].origin, 'Voice Kei');
  await tab.getByRole('button', { name: 'Join Voice', exact: true }).click(); await tab.getByText("You're already connected to voice in another tab.", { exact: true }).waitFor();
  assert.equal((await state(tab)).permissionCalls, 0); await tab.close();
  pass('a second same-identity tab is rejected before acquiring a microphone');
  await b.getByRole('button', { name: 'Leave voice', exact: true }).click();
  await until(async () => (await state(a)).active === 0 && (await state(b)).active === 0, 'peer cleanup after voice leave');
  assert.ok((await state(b)).tracks.every(track => track.readyState === 'ended')); assert.equal((await state(b)).outputs.length, 0); await ready(b);
  await voice(b); await mesh([a, b], 1);
  pass('leaving voice stops tracks and removes peers/audio while staying in the room; rejoining creates no duplicate output');
  const beforeReconnect = (await state(a)).permissionCalls;
  await contexts[0].setOffline(true); await a.evaluate(async () => { const { roomSocket } = await import('/src/services/socket.ts'); roomSocket.io.engine.close(); });
  await a.locator('[data-voice-state="reconnecting"]').waitFor();
  assert.equal((await state(a)).active, 0); assert.ok((await state(a)).tracks.filter(track => track.readyState === 'live').every(track => !track.enabled));
  await contexts[0].setOffline(false); await ready(a); await a.locator('[data-voice-state="joined"]').waitFor(); await mesh([a, b], 1);
  assert.equal((await state(a)).permissionCalls, beforeReconnect);
  pass('temporary signaling disconnect closes peers and pauses tracks, then restores voice using the existing stream');
  await a.reload(); await ready(a); assert.equal((await state(a)).permissionCalls, 0); assert.equal((await state(a)).active, 0);
  await until(async () => (await state(b)).active === 0, 'refresh removes old peer');
  await voice(a); await mesh([a, b], 1);
  pass('refresh does not reacquire a microphone; an explicit new join restores one clean peer');
  await join(c, nodes[0].origin, 'Voice Ari'); await voice(c); await mesh([a, b, c], 2);
  await join(d, nodes[1].origin, 'Separate Guest', 'separate-voice'); await voice(d);
  assert.equal((await state(d)).active, 0);
  pass('three guests form a two-peer-per-browser mesh; another room has no peer or audio leakage');
  await a.getByRole('button', { name: 'Start', exact: true }).click();
  await a.getByRole('button', { name: 'Add task', exact: true }).click(); await a.getByLabel('New task', { exact: true }).fill('Study with company'); await a.locator('.add-task-form').getByRole('button', { name: 'Add', exact: true }).click();
  await b.getByLabel('Study with company', { exact: true }).check();
  await b.getByLabel('Message', { exact: true }).fill('Voice and focus'); await b.getByRole('button', { name: 'Send message', exact: true }).click();
  await a.getByText('Voice and focus', { exact: true }).waitFor();
  await a.getByLabel('Send a star', { exact: true }).click(); await until(async () => await b.locator('[data-reaction-id]').count() === 1, 'reaction while in voice');
  const running = JSON.parse(await redis.command.hget(redis.keys.room('voice-study'), 'state'));
  const microphoneCalls = await Promise.all([a, b, c].map(async p => (await state(p)).permissionCalls));
  await stop(nodes[0]); await delay(1800); await start(nodes[0]);
  await ready(a); await ready(c); await mesh([a, b, c], 2);
  const recovered = JSON.parse(await redis.command.hget(redis.keys.room('voice-study'), 'state'));
  assert.equal(recovered.timer.endsAt, running.timer.endsAt);
  assert.deepEqual(await Promise.all([a, b, c].map(async p => (await state(p)).permissionCalls)), microphoneCalls);
  pass('actual Node crash/restart preserves the timer deadline, study visits and cross-node voice without reacquiring microphones');
  // Complete only this isolated test timer quickly; production duration remains 25 minutes.
  recovered.timer.endsAt = Date.now() + 1200;
  await redis.command.hset(redis.keys.room('voice-study'), 'state', JSON.stringify(recovered), 'version', randomUUID());
  await a.evaluate(async () => { const { roomSocket } = await import('/src/services/socket.ts'); await roomSocket.timeout(5000).emitWithAck('timer:sync', { roomId: 'voice-study' }); });
  await until(async () => await b.locator('.focus-timer').getAttribute('data-phase') === 'shortBreak', 'focus completes in voice');
  await b.getByRole('link', { name: 'Stats', exact: true }).click(); await b.locator('.study-stats[aria-busy="false"]').waitFor();
  const mikaId = await b.evaluate(() => localStorage.getItem('constellate_user_id'));
  const totals = (await pool.query('SELECT count(*)::int AS sessions, sum(completed_pomodoros)::int AS pomodoros, sum(completed_tasks)::int AS tasks FROM study_sessions WHERE guest_id=$1', [mikaId])).rows[0];
  assert.deepEqual(totals, { sessions: 1, pomodoros: 1, tasks: 1 }); await mesh([a, b, c], 2);
  await b.getByRole('link', { name: 'Room', exact: true }).click();
  pass('Pomodoro completes once, task contribution persists, and chat/reactions/stats work while voice stays connected');
  await c.close(); await mesh([a, b], 1);
  await a.screenshot({ path: `${root}/.vite/voice-desktop.png`, fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 }); assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await a.screenshot({ path: `${root}/.vite/voice-mobile.png`, fullPage: true });
  pass('abrupt peer closure cleans up remote audio; compact voice controls fit desktop and mobile');
  await d.getByRole('button', { name: 'Leave voice', exact: true }).click();
  await d.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Test denial', 'NotAllowedError'); }; });
  await d.getByRole('button', { name: 'Join Voice', exact: true }).click(); await d.getByText(/Microphone permission was denied/).waitFor();
  assert.equal((await state(d)).active, 0); await ready(d);
  await a.getByLabel('Leave room', { exact: true }).click(); await a.waitForURL('**/join');
  await until(async () => (await state(b)).active === 0 && (await state(b)).outputs.length === 0, 'whole-room leave removes voice');
  pass('denied microphone permission leaves normal room use intact; leaving the entire room removes voice');
  assert.deepEqual(report.errors, []);
} catch (error) { report.errors.push(error.stack); console.error(error); process.exitCode = 1; }
finally {
  await mkdir(`${root}/.vite`, { recursive: true }); await writeFile(`${root}/.vite/voice-browser-report.json`, JSON.stringify(report, null, 2));
  await browser?.close(); await Promise.all(vites.map(vite => vite.close())); await Promise.all(nodes.map(stop));
  const keys = await redis.command.keys(`${prefix}:*`); if (keys.length) await redis.command.del(...keys); redis.close();
  await pool.end(); assert.match(schema, /^constellate_test_[a-f0-9]{16}$/); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
}
