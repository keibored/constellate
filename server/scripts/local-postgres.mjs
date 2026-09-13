import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const serverRoot = new URL('../', import.meta.url);
const envPath = new URL('.env', serverRoot);
const dataPath = new URL('.local/postgres/', serverRoot);
const markerPath = new URL('.local/database.json', serverRoot);
const action = process.argv[2];
const template = parse(readFileSync(new URL('.env.example', serverRoot)));
let source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
let env = { ...template, ...parse(source), ...process.env };

function setLocalVariable(key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  source = pattern.test(source) ? source.replace(pattern, `${key}=${value}`) : `${source.trimEnd()}\n${key}=${value}\n`;
  writeFileSync(envPath, source.trimStart(), { mode: 0o600 });
  env[key] = value;
}

async function main() {
  if (!['setup', 'start', 'stop'].includes(action)) throw new Error('Use npm run db:setup, db:start or db:stop.');
  if (!env.DATABASE_URL?.trim()) {
    if (action !== 'setup') throw new Error('Run npm run db:setup first, or configure DATABASE_URL for an existing database.');
    const host = env.LOCAL_POSTGRES_HOST;
    const port = Number(env.LOCAL_POSTGRES_PORT);
    if (!['127.0.0.1', 'localhost'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set a loopback LOCAL_POSTGRES_HOST and valid LOCAL_POSTGRES_PORT in server/.env.');
    const suffix = randomBytes(6).toString('hex');
    const url = new URL(`postgresql://${host}:${port}`);
    url.username = `guest_${suffix}`;
    url.password = randomBytes(24).toString('hex');
    url.pathname = `/study_${suffix}`;
    setLocalVariable('DATABASE_URL', url.href);
    url.pathname += '_test';
    setLocalVariable('TEST_DATABASE_URL', url.href);
  }
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('db:start manages only a project-local loopback PostgreSQL instance. For an external database, start it separately.');
  const fingerprint = createHash('sha256').update(url.href).digest('hex');
  if (existsSync(markerPath) && JSON.parse(readFileSync(markerPath, 'utf8')).fingerprint !== fingerprint) throw new Error('DATABASE_URL differs from this local cluster configuration. Restore the original URL; no data has been changed.');
  mkdirSync(new URL('.local/', serverRoot), { recursive: true });
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const { postgres } = await import(`@embedded-postgres/${platform}-${process.arch}`);
  const pgCtl = join(dirname(postgres), process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
  const control = (command, extra = []) => new Promise((resolve, reject) => {
    // PostgreSQL outlives pg_ctl. Ignore inherited pipes so a detached Windows
    // server cannot keep Node's execFile/close callback waiting indefinitely.
    const child = spawn(pgCtl, [command, '-D', fileURLToPath(dataPath), ...extra], { windowsHide: true, stdio: 'ignore' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`pg_ctl ${command} timed out. Check server/.local/postgres.log.`)); }, 30_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`pg_ctl ${command} failed. Check server/.local/postgres.log and whether PostgreSQL is already running.`)); });
  });
  if (action === 'stop') {
    await control('stop', ['-m', 'fast', '-w']);
    console.log('Local PostgreSQL stopped cleanly. Saved data remains in server/.local/postgres.');
    return;
  }
  const cluster = new EmbeddedPostgres({
    databaseDir: fileURLToPath(dataPath), port: Number(url.port),
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    authMethod: 'scram-sha-256', persistent: true, createPostgresUser: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-h', url.hostname],
    onLog: message => { if (/FATAL|ERROR/.test(message)) console.error(message.trim()); },
    onError: () => console.error('Local PostgreSQL reported an error. Check its configuration and port.'),
  });
  if (!existsSync(new URL('PG_VERSION', dataPath))) {
    if (action !== 'setup') throw new Error('The local cluster has not been initialized. Run npm run db:setup.');
    await cluster.initialise();
    writeFileSync(markerPath, JSON.stringify({ fingerprint }, null, 2));
  }
  // pg_ctl detaches PostgreSQL and provides a graceful stop on Windows as well.
  // The initializer has never started a process, so its exit hook owns none.
  const alreadyRunning = await control('status').then(() => true, () => false);
  if (!alreadyRunning) await control('start', ['-l', fileURLToPath(new URL('.local/postgres.log', serverRoot)), '-w', '-o', `-h ${url.hostname} -p ${url.port}`]);
  if (action === 'setup') {
    try {
      const admin = cluster.getPgClient(undefined, url.hostname);
      await admin.connect();
      try {
        const databases = [decodeURIComponent(url.pathname.slice(1))];
        if (env.TEST_DATABASE_URL?.trim()) {
          const testUrl = new URL(env.TEST_DATABASE_URL);
          if (testUrl.host !== url.host || testUrl.username !== url.username) throw new Error('The project-local test database must use the same cluster.');
          databases.push(decodeURIComponent(testUrl.pathname.slice(1)));
        }
        for (const database of databases) {
          if (!database || database.length > 63) throw new Error('Choose a database name with 1–63 characters.');
          const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
          if (!exists.rowCount) await admin.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
        }
      } finally { await admin.end(); }
      console.log('Local PostgreSQL initialized. Credentials are in ignored server/.env; data is in server/.local/postgres.');
      console.log('Next: npm run db:start, then npm run db:migrate.');
    } finally { if (!alreadyRunning) await control('stop', ['-m', 'fast', '-w']); }
  } else {
    console.log(`Local PostgreSQL running on ${url.hostname}:${url.port}. Use npm run db:stop to stop it without deleting data.`);
  }
}

main().catch(error => {
  console.error(`Local PostgreSQL setup/start failed: ${error instanceof Error ? error.message : 'PostgreSQL did not start. Check whether its port is already in use.'}`);
  process.exitCode = 1;
});
