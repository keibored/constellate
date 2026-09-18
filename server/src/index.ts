import { createAppServer } from './app.js';
import { loadServerConfig, loadServerEnvironment, loadRuntimeConfig, ConfigurationError } from './config.js';
import { databaseErrorCode } from './db/pool.js';
import { connectDependencies, StartupError } from './startup.js';
import { PostgresRoomRepository } from './repositories/postgresRoomRepository.js';
import { PostgresStudySessionRepository } from './repositories/postgresStudySessionRepository.js';
import { RedisRoomRuntime } from './redis/roomRuntime.js';
import { log } from './logger.js';
import { createShutdown } from './shutdown.js';

async function main() {
  const environment = loadServerEnvironment();
  const { port, allowedOrigins } = loadServerConfig(environment);
  const options = loadRuntimeConfig(environment);
  const { pool, redis } = await connectDependencies(environment);
  const studyRepository = new PostgresStudySessionRepository(pool);
  const rooms = new PostgresRoomRepository(pool);
  const runtime = new RedisRoomRuntime(redis, rooms, studyRepository);
  const { httpServer, io, closeRuntime, beginDrain } = createAppServer(allowedOrigins, rooms, { runtime, repository: studyRepository }, options);
  const shutdown = createShutdown({
    beginDrain,
    closeConnections: () => new Promise<void>(resolve => {
      // io.disconnectSockets()/namespace disconnect suppresses client retries.
      // A transport close instead triggers the existing reconnect + room rejoin.
      for (const socket of io.sockets.sockets.values()) socket.conn.close();
      io.close(() => resolve());
      httpServer.closeIdleConnections();
    }),
    closeRuntime,
    closeRedis: () => redis.close(),
    closeDatabase: () => pool.end(),
  }, options.shutdownTimeoutMs);
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  const fatal = (event: string, error: unknown) => {
    log('error', event, 'Fatal runtime error; shutting down.', { code: databaseErrorCode(error) });
    process.exitCode = 1;
    void shutdown(event);
  };
  process.once('uncaughtException', error => fatal('server.uncaught_exception', error));
  process.once('unhandledRejection', error => fatal('server.unhandled_rejection', error));
  httpServer.on('error', error => {
    log('error', 'server.listen_failed', `[startup:http] Cannot listen on port ${port}. Check PORT and stop any duplicate backend.`, { port, code: databaseErrorCode(error) });
    process.exitCode = 1;
    void shutdown('listen_error');
  });
  httpServer.listen(port, options.host, () => {
    log('info', 'server.listening', options.production ? 'HTTP and Socket.IO server ready.' : `Server running at http://127.0.0.1:${port} (PostgreSQL ready; Redis ready)`, { port, pid: process.pid });
  });
}

main().catch(error => {
  log('error', 'server.startup_failed', error instanceof StartupError || error instanceof ConfigurationError ? error.message : '[startup] Backend startup failed. Check production environment configuration or server/.env for local development.', { code: databaseErrorCode(error) });
  process.exitCode = 1;
});
