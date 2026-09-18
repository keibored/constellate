import { loadServerEnvironment } from '../config.js';
import { createDatabasePool, databaseErrorCode } from './pool.js';
import { DatabaseSetupError, migrate } from './migrations.js';
import { log } from '../logger.js';

async function main() {
  const pool = createDatabasePool(loadServerEnvironment().DATABASE_URL ?? '');
  try {
    const applied = await migrate(pool);
    log('info', 'database.migrations_complete', applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database migrations are up to date.', { count: applied.length });
  } finally { await pool.end(); }
}

main().catch(error => {
  log('error', 'database.migrations_failed', error instanceof DatabaseSetupError ? error.message : 'Migration failed. Check DATABASE_URL and PostgreSQL connectivity.', { code: databaseErrorCode(error) });
  process.exitCode = 1;
});
