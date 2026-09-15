import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv, resolveConfig } from 'vite';
import { loadServerConfig, loadServerEnvironment } from '../server/src/config.js';
import { connectDependencies, StartupError } from '../server/src/startup.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const clientRoot = fileURLToPath(new URL('../client/', import.meta.url));

export async function requireFreePort(port: number, label: string) {
  await new Promise<void>((accept, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => reject(new StartupError(
      `[dev] ${label} port ${port} is unavailable (${error.code}). Stop the existing Constellate process with Ctrl+C before npm run dev. No new app processes were started.`)));
    probe.listen({ port, exclusive: true }, () => probe.close(error => error ? reject(error) : accept()));
  });
}

async function configuration() {
  const environment = loadServerEnvironment();
  const backend = loadServerConfig(environment);
  const vite = await resolveConfig({ root: clientRoot, configFile: resolve(clientRoot, 'vite.config.ts') }, 'serve');
  const frontendPort = vite.server.port;
  const proxy = vite.server.proxy?.['/socket.io'];
  const api = vite.server.proxy?.['/api'];
  if (!proxy || typeof proxy === 'string' || !api || typeof api === 'string' || !proxy.ws || proxy.target !== api.target) {
    throw new StartupError('[dev] Vite must proxy /api and /socket.io to the same backend, with ws: true for Socket.IO. Check client/vite.config.ts.');
  }
  const target = String(proxy.target);
  const clientEnv = loadEnv('development', clientRoot, 'VITE_SERVER_URL');
  return { environment, backend, frontendPort, target, socketUrl: clientEnv.VITE_SERVER_URL?.trim() };
}

export function requireLocalTarget(value: string, port: number, label: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new StartupError(`[dev] ${label} is not a valid backend URL.`); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || Number(url.port || 80) !== port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new StartupError(`[dev] ${label} does not point to the managed backend on port ${port}. Clear stale client/.env overrides (SERVER_PROXY_TARGET / VITE_SERVER_URL) so the local client follows server PORT.`);
  }
}

export async function waitForBackend(target: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let detail = 'No HTTP listener responded.';
  console.log('[dev] Waiting for backend /api/ready before starting Vite...');
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/ready', target), { signal: AbortSignal.timeout(1500) });
      const status = await response.json() as { status?: string; database?: string; redis?: string };
      if (response.ok && status.status === 'ok' && status.database === 'ok' && status.redis === 'ok') {
        console.log('[dev] Backend, PostgreSQL and Redis are ready. Starting Vite.'); return;
      }
      detail = `Readiness returned HTTP ${response.status}; PostgreSQL ${status.database === 'ok' ? 'ready' : 'unavailable'}, Redis ${status.redis === 'ok' ? 'ready' : 'unavailable'}.`;
    } catch { detail = 'The configured backend is not responding with a valid readiness result.'; }
    await delay(250);
  }
  throw new StartupError(`[dev] Backend did not become ready. ${detail} Vite was not started. Run npm run dev from the project root after npm run db:start and npm run redis:start; check the server startup log.`);
}

async function main() {
  const config = await configuration();
  if (process.argv[2] === 'wait') { await waitForBackend(config.target); return; }
  if (process.argv[2] !== 'check') throw new StartupError('[dev] Expected check or wait. Use npm run dev from the project root.');
  requireLocalTarget(config.target, config.backend.port, 'Vite proxy');
  if (config.socketUrl) requireLocalTarget(config.socketUrl, config.backend.port, 'VITE_SERVER_URL');
  if (config.frontendPort === config.backend.port) throw new StartupError('[dev] Frontend and backend cannot use the same port. Restore backend PORT and client/vite.config.ts.');
  if (!config.backend.allowedOrigins.includes(`http://localhost:${config.frontendPort}`)) {
    throw new StartupError(`[dev] CLIENT_ORIGINS must allow http://localhost:${config.frontendPort} for local development. Keep production origins explicit.`);
  }
  await requireFreePort(config.backend.port, 'Backend');
  await requireFreePort(config.frontendPort, 'Frontend');
  const { pool, redis } = await connectDependencies(config.environment);
  redis.close(); await pool.end();
  console.log(`[dev] Preflight passed. Frontend http://localhost:${config.frontendPort}; backend/proxy http://127.0.0.1:${config.backend.port}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(root);
  main().catch(error => { console.error(error instanceof StartupError ? error.message : '[dev] Startup configuration failed. Check server/.env and client/vite.config.ts.'); process.exitCode = 1; });
}
