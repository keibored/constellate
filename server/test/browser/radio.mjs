import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as viteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createAppServer } from '../../src/app.ts';
import { TestRoomRepository } from '../helpers/testRoomRepository.ts';
import { RedisConnections } from '../../src/redis/connection.ts';
import { RedisRoomRuntime } from '../../src/redis/roomRuntime.ts';
import { parseRoom } from '../../src/redis/roomState.ts';

// Real production socket handlers, Redis storage and Pub/Sub; only SQL accounting
// is stubbed here because this feature does not write durable database records.
const root = fileURLToPath(new URL('../../../', import.meta.url));
assert.ok(process.env.RADIO_TEST_REDIS_URL, 'Set RADIO_TEST_REDIS_URL to a local test Redis instance.');
const prefix = `constellate:radio-browser:${randomUUID()}`;
let ownedRedis;
if (process.env.RADIO_TEST_REDIS_BINARY) {
  const port = new URL(process.env.RADIO_TEST_REDIS_URL).port;
  ownedRedis = spawn(process.env.RADIO_TEST_REDIS_BINARY, ['--bind', '127.0.0.1', '--port', port, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let attempts = 0; attempts < 100; attempts++) {
    const ready = await new Promise(resolve => { const probe = createConnection({ host: '127.0.0.1', port: Number(port) }); probe.on('connect', () => { probe.destroy(); resolve(true); }); probe.on('error', () => resolve(false)); });
    if (ready) break; await delay(50);
  }
}
const redis = new RedisConnections(process.env.RADIO_TEST_REDIS_URL, prefix);
await redis.connect();
const rooms = new TestRoomRepository();
const runtime = new RedisRoomRuntime(redis, rooms, { write: async () => {}, closeExpiredRuntime: async () => {} });
const origins = [], app = createAppServer(origins, rooms, { runtime, repository: {} });
app.httpServer.listen(0, '127.0.0.1'); await once(app.httpServer, 'listening');
const api = `http://127.0.0.1:${app.httpServer.address().port}`;
process.chdir(`${root}/client`);
const vite = await viteServer({ root: `${root}/client`, configFile: false, plugins: [react()],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, proxy: { '/api': api, '/socket.io': { target: api, ws: true } } } });
await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`; origins.push(origin);
const errors = [], pass = message => console.log(`PASS ${message}`);
let browser;
const until = async (fn, message, timeout = 12000) => { const end = Date.now() + timeout; while (!await fn()) { assert.ok(Date.now() < end, message); await delay(50); } };
const room = 'radio-review';
const read = async () => parseRoom(await redis.command.hget(redis.keys.room(room), 'state'), room);
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--autoplay-policy=user-gesture-required'] });
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 1440, height: 1100 } })));
  for (const context of contexts) await context.addInitScript(() => {
    window.__radioAudio = [];
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); this.testSources = []; this.testGains = []; window.__radioAudio.push(this); }
      createBufferSource() { const source = super.createBufferSource(); this.testSources.push(source); return source; }
      createGain() { const gain = super.createGain(); this.testGains.push(gain); return gain; }
    };
  });
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of pages) { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); }
  const [a, b] = pages;
  const join = async (page, name) => {
    await page.goto(`${origin}/?room=${room}`);
    await page.locator('#join-nickname').fill(name);
    await page.getByRole('button', { name: 'Join room', exact: true }).click();
    await page.locator('[data-connection="connected"]').waitFor({ state: 'attached' });
    if (await page.getByRole('button', { name: 'Essential only', exact: true }).count()) await page.getByRole('button', { name: 'Essential only', exact: true }).click();
    await until(() => page.locator('.radio-strip .radio-play').isEnabled().then(enabled => name === 'kei' ? enabled : page.getByRole('button', { name: 'Listen', exact: true }).isEnabled()), 'radio joins');
  };
  const audio = page => page.evaluate(() => window.__radioAudio.map(ctx => ({ state: ctx.state, gain: ctx.testGains[0]?.gain.value, sources: ctx.testSources.length, samples: ctx.testSources.at(-1)?.buffer?.length })));
  await join(a, 'kei'); await join(b, 'mia');
  assert.equal((await audio(a)).length, 0); assert.equal((await audio(b)).length, 0);
  pass('joining never starts audio or creates an AudioContext without a user gesture');
  await a.locator('.radio-strip .radio-play').click();
  await until(async () => (await audio(a)).some(ctx => ctx.state === 'running' && ctx.sources > 0 && ctx.samples > 0), 'host plays original audio');
  assert.equal((await read()).radio.playing, true);
  assert.equal((await audio(b)).length, 0);
  await b.getByRole('button', { name: 'Listen', exact: true }).click();
  await until(async () => (await audio(b)).some(ctx => ctx.state === 'running' && ctx.sources > 0), 'listener opts in');
  assert.equal(await b.locator('.radio-strip .radio-play').isDisabled(), true);
  const unauthorized = await b.evaluate(async () => { const { roomSocket } = await import('/src/services/socket.ts'); return roomSocket.timeout(3000).emitWithAck('radio:command', { roomId: 'radio-review', command: 'pause' }); });
  assert.equal(unauthorized.ok, false);
  pass('both devices produce real audio; listener opts in, and server rejects non-host controls');
  await b.getByLabel('Your volume', { exact: true }).evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '.12');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await until(async () => Math.abs((await audio(b)).at(-1).gain - .12) < .01, 'personal volume applies');
  assert.ok((await audio(a)).at(-1).gain > .3);
  await b.getByRole('button', { name: 'Mute radio for yourself' }).click();
  await until(async () => (await audio(b)).at(-1).gain < .001, 'local mute');
  assert.equal((await read()).radio.playing, true);
  assert.ok((await audio(a)).at(-1).gain > .3);
  pass('volume and mute affect only the listener, without pausing the shared room');
  await b.getByRole('button', { name: 'Open room radio', exact: true }).click();
  await b.getByRole('button', { name: 'Suggest a track', exact: true }).click();
  await b.getByRole('button', { name: 'Add Soft morning to queue', exact: true }).click();
  await a.getByRole('button', { name: 'Open room radio', exact: true }).click();
  await a.locator('.radio-queue').getByText('Soft morning', { exact: true }).waitFor();
  assert.equal((await read()).radio.queue[0].nickname, 'mia');
  await a.locator('.radio-panel').getByRole('button', { name: 'Skip to next track' }).click();
  await until(async () => (await read()).radio.trackId === 'soft-morning', 'shared next');
  await b.locator('.radio-now-playing').getByText('Soft morning', { exact: true }).waitFor();
  await a.locator('.radio-panel').getByRole('button', { name: 'Pause shared radio' }).click();
  const paused = (await read()).radio.positionMs;
  await delay(600); assert.equal((await read()).radio.positionMs, paused);
  pass('suggestions cross Redis Pub/Sub, host skip updates both views, pause preserves position');
  await a.locator('.radio-panel').getByRole('button', { name: 'Ambience', exact: true }).click();
  await a.getByRole('button', { name: 'Choose Rain at the window as current track' }).click();
  await until(async () => (await read()).radio.trackId === 'rain', 'ambience selection');
  await a.locator('.radio-panel').getByRole('button', { name: 'Play shared radio' }).click();
  await until(async () => (await read()).radio.playing, 'rain plays');
  await b.locator('.radio-now-playing').getByText('Rain at the window', { exact: true }).waitFor();
  await delay(3100);
  await a.getByRole('button', { name: 'Add Quiet café to queue' }).click();
  pass('Music and Ambience libraries select and queue synthesized rain and café soundscapes');
  await contexts[1].setOffline(true);
  await b.evaluate(async () => { const { roomSocket } = await import('/src/services/socket.ts'); roomSocket.io.engine.close(); });
  await until(async () => !(await b.locator('.radio-strip .radio-play').isEnabled()), 'offline controls disabled');
  await contexts[1].setOffline(false);
  await b.locator('[data-connection="connected"]').waitFor({ state: 'attached' });
  await until(async () => (await read()).radio.queue.length === 1, 'queue remains on reconnect');
  await b.locator('.radio-now-playing').getByText('Rain at the window', { exact: true }).waitFor();
  pass('reconnect restores current track and queue without replaying controls');
  // Accelerate only this test namespace to the track boundary; the production
  // reducer remains responsible for advancing the queue on the next sync.
  await runtime.flush(room);
  const key = redis.keys.room(room), state = await read();
  state.radio.positionMs = 95950; state.radio.startedAt = Date.now();
  await redis.command.hset(key, 'state', JSON.stringify(state), 'version', randomUUID());
  await a.evaluate(async () => { const { roomSocket } = await import('/src/services/socket.ts'); await roomSocket.timeout(3000).emitWithAck('radio:command', { roomId: 'radio-review', command: 'sync' }); });
  await until(async () => (await read()).radio.trackId === 'cafe', 'automatic queued track transition');
  await a.locator('.radio-now-playing').getByText('Quiet café', { exact: true }).waitFor();
  await b.locator('.radio-now-playing').getByText('Quiet café', { exact: true }).waitFor();
  pass('track completion automatically advances the shared queue in real Redis state');
  await a.locator('.radio-panel').getByRole('button', { name: 'Music', exact: true }).click();
  await a.getByRole('button', { name: 'Choose Moonlit notes as current track' }).click();
  await until(async () => (await read()).radio.trackId === 'moonlit-notes', 'music restored');
  await b.locator('.radio-panel').getByRole('button', { name: 'Music', exact: true }).click();
  await b.getByRole('button', { name: 'Add Soft morning to queue' }).click();
  await until(async () => (await read()).radio.queue.length === 1, 'first preview queue');
  await b.getByRole('button', { name: 'Add Window seat to queue' }).click();
  await until(async () => (await read()).radio.queue.length === 2, 'second preview queue');
  await a.getByRole('button', { name: 'Suggest a track', exact: true }).click();
  await mkdir(`${root}/docs`, { recursive: true });
  await a.screenshot({ path: `${root}/docs/room-radio-preview.png`, fullPage: true });
  await a.keyboard.press('Escape'); assert.equal(await a.locator('.radio-panel').count(), 0);
  await a.setViewportSize({ width: 390, height: 844 });
  await a.getByRole('button', { name: 'Open room radio', exact: true }).click();
  const panel = await a.locator('.radio-panel').boundingBox();
  assert.ok(panel.x >= 0 && panel.x + panel.width <= 390);
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await a.locator('.radio-panel').scrollIntoViewIfNeeded();
  await a.screenshot({ path: `${root}/docs/room-radio-mobile.png`, fullPage: false });
  pass('desktop and 390px mobile layouts fit; Escape dismisses the panel and restores focus');
  await a.evaluate(async () => { const { roomSocket } = await import('/src/services/socket.ts'); await roomSocket.timeout(3000).emitWithAck('room:leave', { roomId: 'radio-review' }); });
  await until(async () => (await read()).radio.hostId === Object.values((await read()).presence).find(guest => guest.member.nickname === 'mia').member.userId, 'host transfers');
  await until(() => b.locator('.radio-panel .radio-play').isEnabled(), 'new host controls');
  await b.locator('.radio-panel .radio-play').click(); assert.equal((await read()).radio.playing, false);
  await b.reload(); await b.locator('[data-connection="connected"]').waitFor({ state: 'attached' });
  assert.equal((await audio(b)).length, 0); assert.equal((await read()).radio.queue.length, 2);
  pass('host departure transfers authority; refresh preserves queue and requires a new Listen gesture');
  assert.deepEqual(errors, []); pass('no browser runtime errors');
} finally {
  await browser?.close(); await vite.close();
  await new Promise(resolve => app.io.close(resolve)); await app.closeRuntime();
  const keys = await redis.command.keys(`${prefix}:*`); if (keys.length) await redis.command.del(...keys);
  redis.close();
  if (ownedRedis) { const exited = once(ownedRedis, 'exit'); ownedRedis.kill(); await exited; }
}
