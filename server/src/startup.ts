import { createDatabasePool, databaseErrorCode } from './db/pool.js';
import { assertMigrationsCurrent, DatabaseSetupError } from './db/migrations.js';
import { RedisConnections, RuntimeUnavailableError } from './redis/connection.js';
import { log } from './logger.js';

export class StartupError extends Error {}

// Log only service host/port, never credentials, database names or URL query options.
function endpoint(value: string, defaultPort: string) {
  try { const url = new URL(value); return `${url.hostname}:${url.port || defaultPort}`; }
  catch { return 'the configured endpoint'; }
}

/** Shared by the real backend and the root development preflight. */
export async function connectDependencies(environment: NodeJS.ProcessEnv) {
  const databaseUrl = environment.DATABASE_URL?.trim(), redisUrl = environment.REDIS_URL?.trim();
  if (!databaseUrl) throw new StartupError('[startup:postgres] DATABASE_URL is missing. Run npm run db:setup or configure server/.env.');
  if (!redisUrl) throw new StartupError('[startup:redis] REDIS_URL is missing. Run npm run redis:setup or configure server/.env.');
  log('info', 'database.connecting', `[startup:postgres] Checking PostgreSQL at ${endpoint(databaseUrl, '5432')} and required migrations...`);
  const pool = createDatabasePool(databaseUrl);
  try { await assertMigrationsCurrent(pool); }
  catch (error) {
    await pool.end();
    const detail = error instanceof DatabaseSetupError ? error.message
      : `Connection failed (${databaseErrorCode(error)}). Run npm run db:start for the project-local service, or start your external PostgreSQL; check DATABASE_URL and run npm run db:migrate.`;
    throw new StartupError(`[startup:postgres] ${detail}`);
  }
  log('info', 'redis.connecting', `[startup:redis] Connecting to Redis at ${endpoint(redisUrl, '6379')}...`);
  let redis: RedisConnections | undefined;
  try {
    redis = new RedisConnections(redisUrl, environment.REDIS_KEY_PREFIX);
    await redis.connect();
    return { pool, redis };
  } catch (error) {
    redis?.close(); await pool.end();
    const causeCode = error instanceof RuntimeUnavailableError ? databaseErrorCode(error.cause) : 'CONFIGURATION';
    const code = causeCode === 'DATABASE_ERROR' ? 'UNAVAILABLE' : causeCode;
    throw new StartupError(`[startup:redis] Connection failed (${code}). Run npm run redis:start for the project-local service, or start your external Redis; check REDIS_URL and REDIS_KEY_PREFIX in server/.env.`);
  }
}
