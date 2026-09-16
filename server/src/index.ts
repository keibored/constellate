import { createAppServer } from './app.js';
import { loadServerConfig, loadServerEnvironment } from './config.js';
import { databaseErrorCode } from './db/pool.js';
import { connectDependencies, StartupError } from './startup.js';
import { PostgresRoomRepository } from './repositories/postgresRoomRepository.js';
import { PostgresStudySessionRepository } from './repositories/postgresStudySessionRepository.js';
import { RedisRoomRuntime } from './redis/roomRuntime.js';

async function main() {
  const environment = loadServerEnvironment();
  const { port, allowedOrigins } = loadServerConfig(environment);
  const { pool, redis } = await connectDependencies(environment);
  const studyRepository = new PostgresStudySessionRepository(pool);
  const rooms = new PostgresRoomRepository(pool);
  const runtime = new RedisRoomRuntime(redis, rooms, studyRepository);
  const { httpServer, io, closeRuntime } = createAppServer(allowedOrigins, rooms, { runtime, repository: studyRepository });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    io.close(() => {
      void (async () => {
        try { await closeRuntime(); }
        catch (error) { console.error(`[study] Final checkpoint failed (${databaseErrorCode(error)}).`); }
        finally { redis.close(); await pool.end(); }
      })().catch(error => console.error(`[database] Shutdown failed (${databaseErrorCode(error)}).`));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  httpServer.on('error', error => {
    console.error(`[startup:http] Cannot listen on port ${port} (${(error as NodeJS.ErrnoException).code ?? 'ERROR'}). Stop the existing backend before starting another; check PORT.`);
    process.exitCode = 1;
    shutdown();
  });
  httpServer.listen(port, () => {
    console.log(`Server running at http://127.0.0.1:${port} (PostgreSQL ready; Redis ready)`);
    console.log(`[startup:http] Listening on port ${port} (PID ${process.pid}).`);
  });
}

main().catch(error => {
  console.error(error instanceof StartupError ? error.message : `[startup] Backend startup failed (${databaseErrorCode(error)}). Check server/.env and the startup configuration.`);
  console.error('[startup] Backend did not start: no HTTP/Socket.IO listener was opened. Fix the error above, then restart npm run dev.');
  process.exitCode = 1;
});
