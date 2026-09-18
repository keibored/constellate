import pg from 'pg';
import { log } from '../logger.js';

export function databaseErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'DATABASE_ERROR';
}

export function createDatabasePool(connectionString: string) {
  if (!connectionString.trim()) throw new Error('DATABASE_URL is required. Run npm run db:setup or configure server/.env.');
  const pool = new pg.Pool({
    connectionString, max: 10, connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000, statement_timeout: 10_000, query_timeout: 12_000,
  });
  // Idle connections can emit errors outside a request; never leave these unhandled.
  pool.on('error', error => log('error', 'database.connection_error', '[database] Idle connection failed. New requests will reconnect.', { code: databaseErrorCode(error) }));
  return pool;
}
