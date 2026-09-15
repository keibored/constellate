import { createAppServer } from './app.js';
import { loadServerConfig, loadServerEnvironment } from './config.js';
import { createDatabasePool, databaseErrorCode } from './db/pool.js';
import { assertMigrationsCurrent, DatabaseSetupError } from './db/migrations.js';
import { PostgresRoomRepository } from './repositories/postgresRoomRepository.js';
import { PostgresStudySessionRepository } from './repositories/postgresStudySessionRepository.js';
import { StudySessionService } from './services/studySessionService.js';

async function main() {
  const environment = loadServerEnvironment();
  const { port, allowedOrigins } = loadServerConfig(environment);
  if (!environment.DATABASE_URL?.trim()) throw new DatabaseSetupError('DATABASE_URL is required. Run npm run db:setup or configure server/.env.');
  const pool = createDatabasePool(environment.DATABASE_URL);
  try { await assertMigrationsCurrent(pool); }
  catch (error) { await pool.end(); throw error; }
  const studyRepository = new PostgresStudySessionRepository(pool);
  try { await studyRepository.recover(); }
  catch (error) { await pool.end(); throw error; }
  const studies = new StudySessionService(studyRepository);
  const { httpServer, io } = createAppServer(allowedOrigins, new PostgresRoomRepository(pool), undefined, { service: studies, repository: studyRepository });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    io.close(() => {
      void (async () => {
        try { await studies.close(); }
        catch (error) { console.error(`[study] Final checkpoint failed (${databaseErrorCode(error)}).`); }
        finally { await studyRepository.release(); await pool.end(); }
      })().catch(error => console.error(`[database] Shutdown failed (${databaseErrorCode(error)}).`));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  httpServer.on('error', error => {
    console.error(`HTTP server failed (${(error as NodeJS.ErrnoException).code ?? 'ERROR'}). Check PORT and existing dev processes.`);
    process.exitCode = 1;
    shutdown();
  });
  httpServer.listen(port, () => console.log(`Server running at http://127.0.0.1:${port} (PostgreSQL ready)`));
}

main().catch(error => {
  console.error(error instanceof DatabaseSetupError ? error.message : `Database startup failed (${databaseErrorCode(error)}). Check DATABASE_URL, start PostgreSQL, and run npm run db:migrate.`);
  process.exitCode = 1;
});
