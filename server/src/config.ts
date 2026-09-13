import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

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
  const result = config({ path: envFile, processEnv: env });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') throw result.error;
  return env;
}

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env, envFile?: string) {
  const env = loadServerEnvironment(environment, envFile);
  const port = Number(env.PORT?.trim() || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535. Set it in server/.env or the process environment.');
  }
  const allowedOrigins = (env.CLIENT_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',').map(origin => origin.trim()).filter(Boolean);

  return { port, allowedOrigins };
}
