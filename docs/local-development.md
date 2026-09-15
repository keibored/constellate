# Local startup and Socket.IO verification

## Root cause

`ECONNREFUSED 127.0.0.1:3000` means Vite attempted a TCP connection while no backend was listening there. It is not a WebRTC or CORS error. The inspected configuration agrees: backend `PORT` defaults to 3000, Vite derives both `/api` and `/socket.io` targets from that same loader, and the client uses the page origin with no `VITE_SERVER_URL` override. Vite keeps `ws: true`. No port changes were necessary.

The original standalone `cd client; npm run dev` started only Vite. The former root command started backend and frontend concurrently without readiness coordination. Since the persistence/Redis milestones, the backend must validate PostgreSQL migrations and connect to Redis before opening its HTTP/Socket.IO listener. If either service is unavailable, the backend child exits, but `tsx watch` remains alive awaiting a file edit/restart. `concurrently -k` therefore does not see its server command exit, and Vite can continue reporting refused connections indefinitely. Starting Vite before a healthy but slower backend can also produce initial errors for an already-open browser.

This was reproduced with an intentionally unavailable database: the PostgreSQL connection failed, no listener opened, and the watcher stayed alive. At inspection time the previously manually started backend was healthy; older terminal lines do not prove a fresh connection is still failing. Live direct/proxied readiness checks distinguish the two.

## Current workflow

From a fresh PowerShell terminal:

```powershell
cd C:\Users\keish\OneDrive\Desktop\constellate
npm.cmd run db:start
npm.cmd run redis:start
npm.cmd run db:migrate
npm.cmd run dev
```

The services are already configured for this workspace. Their start commands preserve saved data and recognize their existing local instance. `db:migrate` is repeatable and applies only pending schema migrations. After services/migrations are ready, `npm.cmd run dev` alone starts the backend and frontend. It does not automatically install or start arbitrary external services.

For a fresh checkout, run `npm.cmd install`, `npm.cmd run db:setup`, and `npm.cmd run redis:setup` first. Do not overwrite an existing `server/.env`: it contains generated local database credentials. For externally managed PostgreSQL/Redis, configure their URLs and start them with their normal service tools rather than using the project-local helpers.

| Process | Address | Requirement |
| --- | --- | --- |
| Vite frontend | `http://localhost:5173` | Starts after backend readiness |
| Express/Socket.IO | `http://127.0.0.1:3000` | PostgreSQL, migrations and Redis must be ready |
| PostgreSQL | `127.0.0.1:5432` | Required durable room/task/study storage; `DATABASE_URL` |
| Redis | `127.0.0.1:6379` | Required live room state and Socket.IO adapter; `REDIS_URL` |

`server/.env` is the server environment file; inherited process variables override it. Backend and Vite share the `PORT` default/loader. No root or client `.env` is required here. Keep `SERVER_PROXY_TARGET` and `VITE_SERVER_URL` blank for the normal local proxy workflow. Exact local origins are allowed in `CLIENT_ORIGINS`; production CORS remains explicit.

Root `predev` checks both app ports before spawning processes, verifies both proxy targets and `ws: true`, checks local origin/URL configuration, then runs the same PostgreSQL/Redis startup checks used by the backend. It fails promptly with actionable logs instead of starting a frontend with no backend. Occupied ports cause a clear error; existing processes are not killed, adopted or duplicated.

The client `predev` waits up to 20 seconds for `/api/ready` to report `status`, `database` and `redis` all `ok`, then starts Vite. The same gate also protects standalone `cd client; npm run dev`; that command still does not create a backend. A readiness timeout exits, causing the root concurrently command to stop its companion process.

Use Ctrl+C in old standalone app terminals before starting the combined workflow. In the root terminal, Enter is routed to the existing server watcher and restarts its backend child. Ctrl+C stops both app processes. PostgreSQL/Redis remain running; stop them separately with `npm.cmd run db:stop` and `npm.cmd run redis:stop` when desired. For two app terminals, start `npm.cmd run dev:server`, wait for readiness, then `npm.cmd run dev:client`.

## Successful connection signals

1. The root terminal prints `[dev] Preflight passed`, the backend listening message on 3000, and only then `Backend, PostgreSQL and Redis are ready. Starting Vite.` The backend also logs its PID to identify the actual listener.
2. Open `http://localhost:5173/api/ready`. It returns HTTP 200 and `{"status":"ok","database":"ok","redis":"ok"}` through the same proxy as the application.
3. Open `http://localhost:5173/r/demo`. The development browser console shows `[Constellate] connected` and `joined room`. Network shows successful Socket.IO polling and a WebSocket upgrade (101).
4. A separate private/profile window shows another guest. Chat, reactions, tasks and the shared timer update in both windows. Two regular tabs intentionally share one guest identity.

Startup logs distinguish `[startup:postgres]`, `[startup:redis]` and `[startup:http]`; they include safe host/port/error codes and the relevant command. They never print connection-string credentials. Failed startup explicitly says no HTTP/Socket.IO listener opened. A missing/mismatched migration names the migration command.

Stopping the backend intentionally while leaving Vite running necessarily makes pending proxy requests fail. Those errors are expected **during that deliberate outage**, and remain visible. The client shows reconnecting; after restarting the backend, ordinary Socket.IO rejoin restores state and proxy requests succeed. No Vite logger/filter or client error suppression was introduced.

## Verification

Run the normal tests/build with `npm.cmd test` and `npm.cmd run build`. With PostgreSQL/Redis running and **both app ports free**, run:

```powershell
npm.cmd run test:dev
```

The test launches the actual documented `npm run dev`, not a replacement server fixture. It uses the configured backend port and Vite 5173, a disposable PostgreSQL test schema, a unique Redis namespace and two isolated Chromium storage contexts. Install Chromium first if needed with `npm.cmd exec -- playwright install chromium`.

It verifies: failed PostgreSQL/Redis startup does not start Vite; duplicate root commands are rejected; clean startup has no refused proxy requests; both browser identities join; chat/reaction/task synchronization works; both timers have the same deadline; real WebRTC peers connect with synthetic microphones; intentionally stopping the backend shows reconnecting; restarting through the original watcher recovers two guests/voice peers without reacquiring media. After the old socket leases expire, Redis contains exactly two active socket records. Expected outage errors are recorded, not filtered. It stores `.vite/dev-startup-report.json` and `.vite/dev-startup.log` and removes only its own processes/data.

The test never captures a physical microphone. Existing Voice V1 tests cover media playback; this startup regression focuses on signaling/reconnect. `server/test/devStartup.test.ts` separately covers mismatched targets, occupied ports, readiness waiting and useful dependency errors. The full database/Redis suites remain available as `npm.cmd run test:db` and `npm.cmd run test:redis`.

Changed for this fix: root/client/server `package.json`, `scripts/dev.ts`, `server/src/startup.ts`, `server/src/index.ts`, `server/src/redis/connection.ts`, the two startup test files, README and this guide. Vite's proxy targets, app UI, Socket.IO client initialization, room protocol, WebRTC logic and local environment values did not need changes.
