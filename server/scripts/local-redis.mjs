import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from 'dotenv';
import { Redis } from 'ioredis';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(root, '.local', 'redis');
const action = process.argv[2];
const version = '8.10.1';
const digest = '5532f2cc38a0185556b648d25a0c2ff1cc58029f37fd76eceb38736976dcb056';
const envPath = join(root, '.env');
const env = { ...process.env }; config({ path: envPath, processEnv: env });
async function main() {
  if (!['setup', 'start', 'stop'].includes(action)) throw new Error('Use redis:setup, redis:start or redis:stop.');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This portable setup supports Windows x64. On Linux/macOS start Redis separately and configure REDIS_URL. See docs/redis-runtime-v1.md.');
  const url = new URL(env.REDIS_URL || 'redis://127.0.0.1:6379');
  if (url.hostname !== '127.0.0.1' || url.username || url.password || (url.pathname && url.pathname !== '/0' && url.pathname !== '/')) throw new Error('The local helper only manages loopback Redis without credentials on database 0. Start an external REDIS_URL separately.');
  const port = Number(url.port || 6379);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local Redis port.');
  mkdirSync(local, { recursive: true });
  const binary = join(local, `Redis-${version}-Windows-x64-cygwin`, 'redis-server.exe');
  const marker = join(local, 'managed.json');
  if (action === 'setup' && !existsSync(binary)) {
    const archive = join(local, `redis-${version}.zip`);
    const response = await fetch(`https://github.com/redis-windows/redis-windows/releases/download/${version}/Redis-${version}-Windows-x64-cygwin.zip`);
    if (!response.ok) throw new Error('Portable Redis download failed.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Portable Redis checksum mismatch. Nothing was extracted.');
    writeFileSync(archive, bytes);
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:CONSTELLATE_REDIS_ARCHIVE -DestinationPath $env:CONSTELLATE_REDIS_DIR -Force'],
      { windowsHide: true, env: { ...process.env, CONSTELLATE_REDIS_ARCHIVE: archive, CONSTELLATE_REDIS_DIR: local }, stdio: 'inherit' });
    if (!existsSync(binary)) throw new Error('Unexpected portable archive layout. Inspect server/.local/redis.');
  }
  if (!existsSync(binary)) throw new Error('Run npm run redis:setup first.');
  const redis = new Redis(url.href, { lazyConnect: true, retryStrategy: () => null, enableOfflineQueue: false, connectTimeout: 1000 });
  redis.on('error', () => {});
  let running = await redis.connect().then(() => true, () => false);
  const owned = async () => {
    if (!existsSync(marker)) return false;
    const saved = JSON.parse(readFileSync(marker, 'utf8'));
    const info = await redis.info('server');
    return saved.port === port && info.includes(`run_id:${saved.runId}\r\n`);
  };
  try {
    if (running && !await owned()) throw new Error('Port is used by an unmanaged Redis process. Configure that service explicitly; this helper will not stop or alter it.');
    if (action === 'stop') {
      if (running) await redis.shutdown('SAVE').catch(error => { if (redis.status === 'ready') throw error; });
      console.log('Project-local Redis stopped. Its snapshot remains in server/.local/redis.'); return;
    }
    if (!running) {
      const log = openSync(join(local, 'redis.log'), 'a');
      const child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--protected-mode', 'yes', '--save', '60', '1', '--dir', '.', '--dbfilename', 'runtime.rdb'],
        { cwd: local, windowsHide: true, detached: true, stdio: ['ignore', log, log] });
      let startFailed = false;
      child.once('error', () => { startFailed = true; });
      child.unref(); closeSync(log);
      for (let attempt = 0; attempt < 30 && !running; attempt++) {
        await delay(200);
        if (startFailed) throw new Error('Redis could not be launched. Check the portable executable and server/.local/redis/redis.log.');
        running = await redis.connect().then(() => true, () => false);
      }
      if (!running) throw new Error('Redis did not start. Check server/.local/redis/redis.log.');
      const runId = /^run_id:(.+)$/m.exec(await redis.info('server'))?.[1].trim();
      writeFileSync(marker, JSON.stringify({ runId, port }));
    }
    if (action === 'setup' && !env.REDIS_URL) {
      const previous = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
      writeFileSync(envPath, previous + `${previous.endsWith('\n') ? '' : '\n'}REDIS_URL=${url.href}\n`);
    }
    console.log(`Project-local Redis ready on 127.0.0.1:${port}. No Windows service, PATH or firewall changes were made.`);
  } finally { redis.disconnect(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
