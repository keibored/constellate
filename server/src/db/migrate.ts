import { loadServerEnvironment } from '../config.js';
import { createDatabasePool, databaseErrorCode } from './pool.js';
import { DatabaseSetupError, migrate } from './migrations.js';

async function main() {
  const pool = createDatabasePool(loadServerEnvironment().DATABASE_URL ?? '');
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database migrations are up to date.');
  } finally { await pool.end(); }
}

main().catch(error => {
  console.error(error instanceof DatabaseSetupError ? error.message : `Migration failed (${databaseErrorCode(error)}). Check DATABASE_URL and that PostgreSQL is running.`);
  process.exitCode = 1;
});
