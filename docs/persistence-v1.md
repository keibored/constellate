# Persistent Room State V1

Room names and shared tasks are now stored in PostgreSQL. The existing room routes, guest identity, artwork and synchronized Pomodoro remain in place. This guide describes the persistence milestone; earlier presence/timer changes may also be present in the working tree.

## Local setup and commands

From the repository root on a fresh checkout:

```sh
npm install
npm run db:setup
npm run db:start
npm run db:migrate
npm run dev
```

In PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

`db:setup` uses the development-only `embedded-postgres` package's native PostgreSQL distribution. It generates a random database role/password and separate development/test database names, writes `DATABASE_URL` and `TEST_DATABASE_URL` to ignored `server/.env`, and initializes `server/.local/postgres`. These are real PostgreSQL databases; no global service or Docker installation is required. Local credentials and database files are Git-ignored. The development role owns its local cluster; use a separately provisioned application role for deployment.

The setup step is already complete in this workspace. For subsequent sessions:

```sh
npm run db:start
npm run db:migrate
npm run dev
```

`db:start` uses `pg_ctl` to start PostgreSQL in the background and returns promptly. It also succeeds if this cluster is already running. `db:migrate` applies only pending migrations. `npm run dev` uses the existing `concurrently` command to start both app processes and stop the companion when either exits. Stop a previously running client/backend before starting a second copy.

| Service | Default address |
| --- | --- |
| Vite frontend | `http://localhost:5173/r/demo` |
| Express and Socket.IO | `http://127.0.0.1:3000` |
| PostgreSQL | `127.0.0.1:5432` |

The original proxy error occurred because `cd client` / `npm run dev` starts only Vite. Both `/api` and `/socket.io` use the same Vite proxy, derived from the backend's `PORT`, with `ws: true`. The browser Socket.IO client uses the frontend origin by default. Backend port 3000 was retained. Exact local Vite origins are allowed by Express/Socket.IO; deployments should set `CLIENT_ORIGINS` to their own frontend origin.

For separate app terminals, keep PostgreSQL running and use these from the root:

```sh
# Terminal 1
npm run dev:server
# Terminal 2
npm run dev:client
```

Stop the app with Ctrl+C. To stop only the project-local PostgreSQL instance cleanly:

```sh
npm run db:stop
```

Data remains in `server/.local/postgres`. Preserve that folder and the generated `server/.env`; deleting them is not part of normal startup. Database logs are in `server/.local/postgres.log`. The launcher checks a configuration fingerprint and refuses to manage an existing cluster with a different `DATABASE_URL`.

`LOCAL_POSTGRES_HOST` and `LOCAL_POSTGRES_PORT` in `server/.env.example` provide the loopback defaults used when generating a new cluster's URL. Once configured, `DATABASE_URL` supplies its connection settings. No client `.env` or root `.env` is needed. Do not copy the example over an already configured server file.

### Using an existing PostgreSQL installation

Start that PostgreSQL service and create an application role and database using its normal administration tools or provider. Set this in `server/.env`, using the real values for your database:

```dotenv
DATABASE_URL=postgresql://USER:PERCENT_ENCODED_PASSWORD@HOST:PORT/DATABASE
TEST_DATABASE_URL=postgresql://USER:PERCENT_ENCODED_PASSWORD@HOST:PORT/SEPARATE_TEST_DATABASE
```

Percent-encode reserved characters in the username/password. Follow your provider's TLS connection requirements when connecting remotely. `TEST_DATABASE_URL` is needed only for the database integration suite, and its role must be able to create/drop schemas in the test database. Credentials are never sent to the frontend.

Then run `npm run db:migrate` followed by `npm run dev`. Skip `db:setup`, `db:start` and `db:stop` for an externally managed database. Environment variables supplied by the process take precedence over `server/.env`.

## Tables and migrations

| Table | Persistent fields and constraints |
| --- | --- |
| `rooms` | `id` is the existing unique room slug/code and primary key; `name`, durable `revision`, `created_at`, `updated_at`. No replacement invite identifier is introduced. |
| `tasks` | Server-generated UUID `id`, `room_id`, `title`, `completed`, `created_by`, creator name/avatar snapshots, `request_id`, `created_at`, `updated_at`. `room_id` references `rooms(id) ON DELETE CASCADE`; `(room_id, request_id)` is unique; tasks are indexed by room and creation order. |
| `schema_migrations` | Applied SQL filename, SHA-256 checksum and application timestamp. Maintained by the migration runner. |

Application schema files:

- [`server/db/migrations/001_create_rooms.sql`](../server/db/migrations/001_create_rooms.sql)
- [`server/db/migrations/002_create_tasks.sql`](../server/db/migrations/002_create_tasks.sql)

Run `npm run db:migrate` from the root, or `npm run db:migrate --prefix server`. The runner checks out one connection, obtains a transaction-scoped PostgreSQL advisory lock, checks applied-file checksums, and applies pending SQL plus migration records atomically. A failed migration rolls back. Reruns skip already applied SQL. Add a new numbered migration for future changes instead of editing an applied file. Backend startup verifies the schema is current and provides the migration command if it is missing.

No socket IDs, online/offline flags, desks or connection records are stored. Task creator attribution is a snapshot of the existing guest, not a new account or authentication system. Deleting a room at the database level cascades to its tasks; this milestone does not add a room deletion UI.

## Connections and authoritative updates

`server/src/db/pool.ts` creates one `pg.Pool` per backend: maximum 10 connections, a 5-second connection timeout, a 30-second idle timeout and a 10-second statement timeout. Repositories reuse this pool. Each transaction releases its connection in `finally`; failures roll back. Idle pool errors and operation failures log a safe error code without credentials. Shutdown closes app connections and drains the pool. Startup fails with a useful message when the database or migrations are unavailable.

`GET /api/health` checks the HTTP server. `GET /api/ready` queries PostgreSQL, returning 200 with `{"status":"ok"}` or 503 if the database is unavailable. Both work through Vite at `http://localhost:5173/api/...`.

Joining first loads or creates the room and its ordered tasks in PostgreSQL. The default name remains **Late night grind**. A new room starts with no saved tasks; old mock task arrays and unsaved browser-local edits have no durable data to migrate. Successful joins then establish ephemeral presence and receive room, timer and chat snapshots. A join generation check prevents a slow query from restoring membership after a leave, disconnect or room switch.

Task actions follow this sequence:

1. Validate the payload and the socket's active room membership. Creator ID/name/avatar come from that membership.
2. Lock this room's row in a transaction and apply parameterized SQL. Other rooms can write independently.
3. Increment the room revision for a change, read the full canonical snapshot, and commit.
4. Broadcast `room:state` to the original room and acknowledge success. A database failure produces a failed acknowledgement and no unsaved broadcast.

The client uses a single room-state subscription, displays only server snapshots, and ignores older revisions for the current connection. Reconnect/switch requests the current persisted state. Create requests include a UUID request ID, deduplicated while the corresponding task exists. Completion requests carry the desired boolean, so duplicate completion requests do not flip the task twice. Controls are disabled while disconnected or saving; acknowledgement timeouts trigger a fresh connection/snapshot without automatically replaying mutations.

All joined guests can change shared tasks and rename the room. Invite links remain shareable guest access. This continues the single active backend architecture; multi-server Socket.IO broadcasting is outside this milestone.

## Socket.IO contract

Mutation/sync acknowledgements use the existing `{ ok: true }` or `{ ok: false, error }` convention. Failures also emit `room:error` with the operation, leaving unrelated presence/timer/chat connection state intact.

| Direction | Event | Payload / result |
| --- | --- | --- |
| Client to server | `tasks:sync` | `{ roomId }`; sends the current snapshot to the requester. |
| Client to server | `task:create` | `{ roomId, title, requestId }`; trimmed title, 1–100 characters; UUID request ID. |
| Client to server | `task:toggle` | `{ roomId, taskId, completed }`; UUID task ID and explicit boolean. |
| Client to server | `task:delete` | `{ roomId, taskId }`; UUID task ID in the joined room. |
| Client to server | `room:rename` | `{ roomId, name }`; trimmed name, 1–32 characters. |
| Server to client | `room:state` | `{ roomId, room, tasks, revision }`; room metadata, complete ordered task list and durable revision. |

Task records include ID, room ID, title, completion, creator details, request ID and timestamps. Shared TypeScript contracts live in `shared/roomState.d.ts` and `shared/presence.d.ts`. Existing presence, chat and Pomodoro events are retained.

Room names and tasks survive backend and database restarts. Active Pomodoro state, presence and recent chat remain in memory and reset on backend restart. The later [guest recovery milestone](guest-recovery-v1.md) restores room-specific status preferences from localStorage as clients rebuild presence. Reactions retain their existing local behavior. No timer rewrite, authentication pages or UI redesign is included.

## Verification commands

```sh
npm test
npm run test:db
npm run build
```

The regular suite uses a test-only repository. The database suite requires the separately configured test database, creates unique temporary schemas, and cleans up only its own schemas. It covers migrations/checksums, PostgreSQL transactions, concurrent creates, request deduplication, foreign-key cascade, Socket.IO task syncing/isolation, and stopping/restarting the actual compiled backend while preserving room/task IDs, timestamps and completion. Failure tests ensure no unsaved broadcast and no late join after leaving. Both builds include TypeScript checks; no lint script is configured.

### Manual verification

1. Start PostgreSQL, migrate, then start both app processes. Open `/api/ready` through port 5173 and confirm status `ok`. Open `/r/persistent-study` in a regular window (A) and an incognito window or different profile (B). Join as different guests; both show two members and no proxy connection-refused error.
2. A creates **Review WebSocket notes**. B immediately sees the same task. Add **Write a summary** as a second task.
3. B completes the first task. A sees it completed. Uncomplete and complete again; both views agree.
4. A adds then deletes a disposable task using its remove button. B sees it disappear.
5. Rename the room to **Tomorrow together**. Refresh each browser. Name, task IDs/content, completion and the two-member count remain correct.
6. Stop only the backend (use separate app terminals for this check), then restart `npm run dev:server`. Browsers reconnect automatically. The same room name and saved tasks return, including the completed first task. Presence is rebuilt without duplicate guests. Active timer and chat are intentionally not persisted. A terminal join failure still offers Reconnect.
7. Open `/r/another-study-room`. Its task board starts empty and edits stay isolated from the first room. Existing `/room/...` aliases and copied invite URLs still join their matching room.
8. In A/B, start, pause, resume and reset the Pomodoro. Both displays agree. Change a guest status and verify both Members and desks update.
9. Send a chat message in each direction. Verify one copy per view. Click the existing reaction controls and confirm their local animation/recent reaction behavior still works.
10. Briefly take A offline while B creates a task. Restore A's connection: it recovers the saved list, shows exactly one entry for each guest and does not resend an old task. Check desktop/mobile layout and browser errors.

These two isolated-browser scenarios, including an actual backend process restart, were exercised during this milestone. The normal and PostgreSQL suites provide repeatable regression coverage.

## Files changed in this milestone

| Area | Files |
| --- | --- |
| Setup and documentation | `.gitignore`, `package.json`, `package-lock.json`, `server/package.json`, `server/.env.example`, `server/scripts/local-postgres.mjs`, `README.md`, `docs/persistence-v1.md` |
| Schema and database layer | `server/db/migrations/001_create_rooms.sql`, `server/db/migrations/002_create_tasks.sql`, `server/src/db/pool.ts`, `server/src/db/migrations.ts`, `server/src/db/migrate.ts`, `server/src/repositories/roomRepository.ts`, `server/src/repositories/postgresRoomRepository.ts` |
| Server integration | `server/src/config.ts`, `server/src/index.ts`, `server/src/app.ts`, `server/src/socket/index.ts`, `server/src/socket/persistentRoom.ts` |
| Shared contract | `shared/roomState.d.ts`, `shared/presence.d.ts` |
| Existing UI integration | `client/src/features/tasks/TaskBoard.tsx`, `client/src/features/tasks/useRoomState.ts`, `client/src/features/tasks/roomState.ts`, `client/src/features/room/RoomPage.tsx`, `client/src/features/room/RoomInfoCard.tsx`, `client/src/styles/tasks.css` |
| Tests | `server/test/helpers/testRoomRepository.ts`, `server/test/clientRoomState.test.ts`, `server/test/persistentRoom.test.ts`, `server/test/database/persistence.test.ts`, `server/test/presence.test.ts`, `server/test/roomChat.test.ts`, `server/test/devConnection.test.ts` |

The generated `server/.env` and `server/.local` contents are local-only and ignored by Git. No credentials belong in committed files.
