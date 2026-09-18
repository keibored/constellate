# Redis runtime + multi-server readiness V1

This is the current runtime architecture. The original persistence, guest recovery and stats guides describe their first milestones; their single-process memory and restart descriptions are superseded here. Voice builds on this runtime; see [Voice V1](voice-v1.md).

## State ownership and inspection findings

Before this change, `RoomPresence`, `RoomTimer`, `RoomChat`, `StudySessionService` and `StatsAccess` kept room state in process-local Maps/Sets. A global PostgreSQL advisory ownership lock allowed only one study-accounting backend. The old Reactions panel displayed local demo entries rather than shared events. The existing Vite configuration already used the backend `PORT` for `/api` and `/socket.io`, including WebSocket upgrades; starting only the client did not start that backend.

| Classification | State | Current owner |
| --- | --- | --- |
| Persistent | Room ID/name, shared tasks and completion, room/guest study visits, deduplicated focus/Pomodoro/task activity, stats/history | PostgreSQL; existing migrations 001–003 |
| Ephemeral shared | Guest presence, guest-to-socket ownership, leases/grace, statuses, stable desks, active timer/deadline, active visit/cycle coordination, unacknowledged accounting events, capped chat/reactions/rate windows, voice ownership, scoped stats access | Redis |
| Process-local | Actual socket objects, this node's socket bookkeeping, queued operations, heartbeat/sweep handles, in-flight SQL drains, signaling rate window for the one owning socket | Node |
| Browser-local | Guest/profile/status preferences and last room in localStorage; active MediaStream/peer connections only in memory | Browser |

Historical records and task truth were not moved into Redis. The pending accounting list is a retry outbox, removed after PostgreSQL acknowledges a transaction; it is not a second history store. Production `createAppServer` requires the shared runtime. The old in-memory services remain only for legacy regression fixtures (`server/test/helpers/appServer.ts`), with no production fallback.

## Connections, configuration and keys

Installed server dependencies: `ioredis` 6.x and `@socket.io/redis-adapter` 8.x (exact installed versions in `package-lock.json`). Three separate connections handle commands, adapter publishing and adapter subscriptions. All must be ready before new Socket.IO handshakes are accepted. Connection options disable offline command queuing, bound command retries/timeouts and back off reconnection up to five seconds. Logs report transitions without printing credential-bearing URLs.

```dotenv
REDIS_URL=redis://127.0.0.1:6379
REDIS_KEY_PREFIX=constellate
```

An external service can use an authenticated `redis://` URL or TLS `rediss://` URL. Credentials stay in ignored `server/.env`, never in Vite variables or the browser. Share the exact prefix **and PostgreSQL database/schema** across nodes of one deployment; isolate prefixes between deployments and tests.

Key generation lives in `server/src/redis/connection.ts`:

| Key/channel | Type and contents | Retention |
| --- | --- | --- |
| `<prefix>:room:<roomId>:runtime` | HASH with opaque `version` and JSON `state`; schema version, generation UUID, presence/sockets, timer, active visits, pending accounting, chat/reactions, voice | Renewable one-hour TTL, extended for running timer; no expiry while SQL accounting is pending |
| `<prefix>:runtime:due` | Sorted set of room IDs scored by next relevant deadline | Scheduler index; removes missing/deleted/expired rooms |
| `<prefix>:access:<randomToken>` | JSON guest/room/socket scope for HTTP stats | 15 minutes, refreshed by `stats:access`; revoked on leave and invalid without a live owner socket |
| `<prefix>:socket.io...` | Adapter Pub/Sub channels | Transport only, no durable event log |

Guest socket sets are serialized dictionaries inside the room HASH, not JavaScript Sets or separate per-socket keys. Voice stores only guest ownership metadata (`socketId`, per-tab nonce, voice session UUID, mute). It stores no audio, SDP history or ICE candidates.

## Atomic state and presence

Each action loads the opaque version plus Redis TIME, applies a pure state transition, and uses a Lua compare-and-set to atomically replace room state, expiry and the due index. A conflict reloads and retries, up to 40 attempts. This makes concurrent joins, tab ownership, timer transitions and study contributions consistent across processes; no process has its own independent room truth.

One persistent guest can own sockets on several nodes and still has one member/desk/visit. Each node refreshes its actual sockets every **15 seconds**, with a **45-second lease**. Known disconnect removes only that socket; the final ordinary socket disconnect starts **15 seconds of grace**. Explicit room Leave removes the last socket/member immediately. Voice ownership is removed as soon as its particular socket disconnect is observed, even if another silent tab stays online.

A process crash cannot run disconnect handlers. Other nodes (or a restarted node) expire its leases, then finish normal guest grace. A five-second sweep processes up to 50 due rooms per pass. There is no scan of every room, per-second timer write, or global application broadcast. Membership actions also normalize overdue state before acting.

Presence, timer and voice snapshots are refreshed on the 15-second ownership heartbeat, repairing missed notifications if a process dies after a Redis commit but before its broadcast. Snapshot revisions reject older same-generation replies. Pub/Sub is not a durable message replay system: reconnect reloads chat/tasks, and a message committed immediately before a crash can require reconnect to reappear in a remote UI.

## Timers and study accounting

The existing 25-minute focus/five-minute break model is serialized with phase, status, duration/remaining milliseconds, `startedAt`, `endsAt` and revision. Redis TIME supplies server time. Clients render from a server snapshot/deadline; they never decide completion.

Node restart does not reset a timer while Redis retains its state. The next sweep, join or action settles an overdue phase and emits the correct idle next phase once. Pausing freezes remaining time; resume creates a new deadline; reset discards that cycle. Concurrent Start requests cannot restart an already running timer. Empty running rooms may finish without occupants.

Study gathering/guest visit IDs are shared, so two tabs/nodes do not create two visits. Focus intervals stop at the minimum of current time, timer deadline and the guest's last live socket lease. Known disconnect stops focus immediately; an unobserved process/network failure can count at most the remaining **45-second lease** before detection. This is a bounded approximation, not proof of human attention. Pause, idle and break do not count.

Meaningful presence/timer actions and one-minute checkpoints enqueue uniquely identified SQL events. Room-scoped PostgreSQL transaction advisory locks serialize writers from different nodes. The existing activity uniqueness rules make replays safe; a failed Redis acknowledgement after a successful SQL commit cannot inflate totals. Pending events prevent Redis TTL expiry until committed. Completed cycles credit one Pomodoro per contributing guest, assigned to their latest contributing visit; task contributions remain part of the PostgreSQL task transaction.

If runtime state is missing, its next generation closes stale SQL visits at their saved checkpoint under the same room lock. A durable generation receipt prevents a replay from closing newly created visits. Sweeping a missing runtime also rechecks Redis while holding the SQL lock. A deleted PostgreSQL room causes its runtime/due entry to be removed when next accessed/swept; idle cleanup bounds otherwise untouched state. Live restore never silently recreates a deleted room.

## Expiry and failures

Empty rooms retain ephemeral state for approximately **one hour** after the final guest leaves. Running timers are allowed to finish and their key TTL extends at least one hour beyond their deadline. Once inactive and without pending accounting, the due sweep/TTL removes runtime state. Persistent room/task/history rows remain. Rate windows are pruned, chat is capped at 100 messages and recent reactions at three; abandoned guests/voice owners expire by lease. Stats tokens expire independently.

Corrupt JSON/schema fails closed with a repair log; pending accounting is not silently overwritten. Redis outage marks readiness unavailable, rejects room operations and closes local transports so the existing client reconnect path runs. There is no competing memory fallback. On recovery, ioredis resubscribes and the room reloads shared state. PostgreSQL outage prevents authoritative durable operations; pending accounting remains queued for retry.

`GET /api/health` checks the server, PostgreSQL and all Redis connections and returns 200 or 503 with `status`, `server`, `database` and `redis`; it reveals no credentials. `GET /api/ready` is a compatible alias.

Redis itself remains a dependency. Node-restart continuity assumes Redis kept its data. The portable development service saves an RDB snapshot after 60 seconds with changes and on clean `redis:stop`. A Redis crash/data loss can lose state and accounting newer than its snapshot; this V1 does not claim cross-database exactly-once durability through total Redis loss. Production needs deliberate Redis persistence, memory/eviction policy, monitoring and availability planning. Redis Cluster is not supported by the two-key Lua layout in this V1; use one Redis endpoint compatible with these operations.

## Local services and commands

The workspace had no Docker, Redis/Memurai service or usable WSL installation. The helper uses a project-local Windows x64 community [Redis Windows build 8.10.1](https://github.com/redis-windows/redis-windows/releases/tag/8.10.1), downloaded from its release and checked against the pinned SHA256 in `server/scripts/local-redis.mjs`. It binds loopback only, records the process run ID, and refuses to stop an unmanaged Redis occupying the configured port. No machine service/PATH/firewall changes are made. This is a development convenience, not an official Redis production Windows distribution.

```powershell
# First time only; preserve existing server/.env
npm.cmd install
npm.cmd run db:setup
npm.cmd run redis:setup

# Each development session, from repository root
npm.cmd run db:start
npm.cmd run redis:start
npm.cmd run db:migrate
npm.cmd run dev
```

Frontend: `http://localhost:5173`; backend: `http://127.0.0.1:3000`. PostgreSQL: 5432; Redis: 6379. The Redis milestone adds no SQL migration beyond the existing 001–003; `db:migrate` remains safe to rerun. The root dev command starts both app processes, not database services. Stop with Ctrl+C, then `npm.cmd run redis:stop` and `npm.cmd run db:stop` if desired. Data stays in ignored `server/.local/`.

On Linux/macOS or with an existing managed Redis, start that service using its normal tools, set `REDIS_URL`, and skip the Windows helper. On Windows, an existing Redis-compatible service or Docker Redis is also usable if installed/configured independently. Never expose a no-password Redis port publicly. The helper intentionally refuses authenticated/external URLs; it cannot manage those services.

## Two-backend development test

Start PostgreSQL/Redis and migrations as above. Ensure no older Vite/backend is already occupying these ports. Use three PowerShell terminals in the repository root:

```powershell
# Terminal 1: normal node A + frontend A
npm.cmd run dev
```

```powershell
# Terminal 2: node B, with its frontend origin allowed
$env:PORT = '3001'
$env:CLIENT_ORIGINS = 'http://localhost:5174,http://127.0.0.1:5174'
npm.cmd run dev:server
```

```powershell
# Terminal 3: frontend B proxies to node B
$env:PORT = '3001'
npm.cmd --prefix client run dev -- --port 5174
```

Leave `SERVER_PROXY_TARGET` and `VITE_SERVER_URL` blank. Both nodes inherit the same `DATABASE_URL`, `REDIS_URL` and `REDIS_KEY_PREFIX` from `server/.env`. Open `http://localhost:5173/r/demo` and `http://localhost:5174/r/demo`. Different origins have separate localStorage, so these are two guests. Change a status, send chat/reaction, create/complete a task and start/pause the timer; both views should agree. Join voice from both; media peers should connect across the two signaling servers. To test a shared guest across nodes, the integration suite explicitly supplies the same guest ID.

Stop node A only; B should continue working. Restart A; its clients should recover the same running deadline and visits within grace/lease bounds. Restore default ports by opening a fresh terminal or removing the temporary process environment variables.

No load balancer was added. A future load balancer must provide sticky routing when Socket.IO polling is enabled; the Redis adapter does not share Engine.IO transport sessions. The adapter supports cross-node broadcasts but not built-in Socket.IO connection-state recovery; the application explicitly rejoins/resynchronizes. See the [official adapter documentation](https://socket.io/docs/v4/redis-adapter/).

## Verification

Run `npm.cmd test`, `npm.cmd run test:db`, `npm.cmd run test:redis`, `npm.cmd run test:browser` and `npm.cmd run build` after installing the Playwright browser as in README. Redis integration tests use unique namespaces and disposable test schemas, never FLUSHDB/FLUSHALL. The service-restart test launches a separate owned Redis on a free port, saves/stops/restarts it and verifies both nodes recover subscriptions, readiness, two guests and the same deadline. On other machines, set `TEST_REDIS_SERVER` to a Redis executable if the Windows portable binary is unavailable; that one service test otherwise reports a skip.

Manual checks:

1. Join the same room in normal/private windows: two guests. Refresh: no duplicate. Open another normal tab: still two guests, with one logical owner for that identity. Close only one same-guest tab: the remaining tab stays online.
2. Start/pause/resume/reset the timer from alternate windows. Start simultaneously: one deadline. Stop/restart Node while Redis stays up: countdown reflects elapsed time. Let a focus deadline pass during downtime: next phase and one Pomodoro credit on recovery, not a restarted focus.
3. Complete/undo/recomplete a shared task: saved task state synchronizes, credit does not inflate. Refresh/restart and check room name, task IDs, personal/room stats and history.
4. Open a different room: no presence, timer, chat, task, reaction or voice leakage.
5. In a disposable development session, `npm.cmd run redis:stop`: `/api/ready` becomes 503 and clients show reconnecting. `npm.cmd run redis:start`: clients recover with one guest each; events cross nodes again. Do not stop a shared production/external service for this test.
6. Repeat the actions through the two different frontends above. Inspect Network to confirm polling/WebSocket upgrades and `/api` use Vite, and normal running terminals have no ECONNREFUSED errors. Intentional backend-stop tests can naturally show temporary proxy errors during the stop.

## Files and remaining scope

Runtime: `server/src/redis/{connection,roomState,roomRuntime,statsAccess}.ts`; production integration: `server/src/{app,index}.ts`, `server/src/socket/sharedRoom.ts`; durable adapters: `server/src/repositories/{roomRepository,postgresRoomRepository,studySessionRepository,postgresStudySessionRepository}.ts`, `server/src/socket/persistentRoom.ts`, `server/src/routes/stats.ts`, `server/src/services/statsAccess.ts`.

Client/protocol: `client/src/features/presence/useRoomPresence.ts`, `client/src/features/reactions/ReactionsPanel.tsx`, `client/src/features/room/RoomPage.tsx`, `shared/{presence,reactions}.d.ts`. Workflow: root/server `package.json`, lockfile, `server/.env.example`, `server/scripts/local-redis.mjs`, README and this guide. Tests: `server/test/redisRoomState.test.ts`, `server/test/redis/runtime.test.ts`, `server/test/helpers/appServer.ts`, existing fixture import updates in `devConnection`, `persistentRoom`, `presence`, `roomChat`, `database/persistence`, `database/studyStats`; real-browser coverage also exercises the runtime.

No authentication, Redis HA/Cluster, load balancing, durable chat, metrics dashboard or deployment infrastructure was introduced. Anonymous guest IDs remain client supplied; scoped tokens prevent accidental cross-guest HTTP access but do not make a browser guest ID an authenticated account. Per-room JSON CAS favors simplicity for small rooms rather than massive room throughput. Voice-specific scope and limitations are documented separately.
