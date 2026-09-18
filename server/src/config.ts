import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

export class ConfigurationError extends Error {}

/** Shared by the backend entry point and Vite's Node-only proxy configuration. */
export function loadServerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  envFile = fileURLToPath(new URL('../.env', import.meta.url)),
) {
  // Resolve server/.env from this module, independently of the launch directory.
  // Keep backend variables out of Vite's process environment and client bundle.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) env[key] = value;
  }
  // Production receives configuration from the host, never a developer's .env.
  if (env.NODE_ENV === 'production') return env;
  const result = config({ path: envFile, processEnv: env });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') throw result.error;
  return env;
}

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env, envFile?: string) {
  const env = loadServerEnvironment(environment, envFile);
  const port = Number(env.PORT?.trim() || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT must be an integer from 1 to 65535. Set it in server/.env or the process environment.');
  }
  const allowedOrigins = (env.CLIENT_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(origin => origin.trim()).filter(Boolean);
  if (env.NODE_ENV === 'production' && !env.CLIENT_ORIGINS?.trim()) {
    throw new ConfigurationError('CLIENT_ORIGINS is required in production. Set exact HTTPS frontend origins.');
  }
  for (const origin of allowedOrigins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new ConfigurationError('CLIENT_ORIGINS must contain exact HTTP(S) origins.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || origin.includes('*')) {
      throw new ConfigurationError('CLIENT_ORIGINS must contain exact HTTP(S) origins without paths, credentials or wildcards.');
    }
    if (env.NODE_ENV === 'production' && (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new ConfigurationError('Production CLIENT_ORIGINS must use non-loopback HTTPS origins.');
    }
  }

  return { port, allowedOrigins };
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key]?.trim() || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new ConfigurationError(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  if (env.LOG_LEVEL && !['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL)) throw new ConfigurationError('LOG_LEVEL must be debug, info, warn or error.');
  return {
    production: env.NODE_ENV === 'production',
    host: env.HOST?.trim() || '0.0.0.0',
    trustProxy: integer('TRUST_PROXY_HOPS', 0, 0, 10),
    healthTimeoutMs: integer('HEALTH_TIMEOUT_MS', 2000, 100, 10000),
    shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', 25000, 1000, 120000),
  };
}
