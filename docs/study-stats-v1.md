# Study Session History + Stats V1

> Historical milestone guide. Current runtime, restart, setup and voice behavior is documented in [Redis runtime V1](redis-runtime-v1.md) and [Voice V1](voice-v1.md); those supersede the single-backend ownership and recovery descriptions below.

Constellate now records guest study visits and meaningful activity in PostgreSQL. Open **Stats** in the existing room navigation or append `#stats` to a room URL, for example `http://localhost:5173/r/demo#stats`. The room's presence, task, chat and timer components stay mounted while this view is open. Tasks/Members still return to their existing sections; Settings remains its existing dialog.

## Setup, migration and commands

The schema change is [`server/db/migrations/003_study_sessions.sql`](../server/db/migrations/003_study_sessions.sql). It uses the existing checksum-protected migration runner. It has already been applied to this workspace's local development database. No environment changes, new packages or account setup are required.

From the repository root:

```powershell
npm.cmd run db:start
npm.cmd run db:migrate
npm.cmd run dev
```

For separate terminals, use `npm.cmd run dev:server` and `npm.cmd run dev:client` after starting/migrating PostgreSQL. The existing addresses remain frontend **5173**, backend **3000**, PostgreSQL **5432**. `server/.env` remains ignored and provides `DATABASE_URL` / the separate `TEST_DATABASE_URL`.

```powershell
npm.cmd test
npm.cmd run test:db
npm.cmd run build
```

There is no lint command configured. Both builds type-check. Database tests use uniquely named disposable schemas in the separate test database. No commit or push is part of this milestone.

## Tables and indexes

| Table | Purpose |
| --- | --- |
| `room_study_sessions` | A continuous room gathering: UUID, room FK, first-guest start, final-guest end and last checkpoint. A partial unique index allows only one open gathering per room. Room/date/ID index supports recent gathering lookup. |
| `study_sessions` | One logical guest visit in a room: UUID, room and gathering FKs, existing guest ID, start/end/checkpoint timestamps, end reason, millisecond focus total, generated `focus_seconds`, Pomodoro count, task count and creation timestamp. A partial unique index allows one open visit per room/guest. Guest/date/ID and room/gathering indexes support history and aggregates. |
| `study_activity` | Persisted focus intervals and task/Pomodoro contributions. `(session_id, kind, reference_id)` is the primary key, making retries idempotent. A session/end-time index supports date-range queries. |

Guest IDs accept existing valid legacy IDs as well as newly generated UUIDs. No authenticated users table is introduced. Rooms cascade to gatherings/visits, and visits cascade to activity. A task's UUID is retained as a historical reference without a task foreign key, so deleting the task does not erase an earned contribution. Deleting a room deletes its related history through foreign keys; this milestone adds no room deletion UI.

No socket IDs, online/offline flags, status/desk maps or access tokens are stored in these tables. Visit start/end and measured activity are historical application data. Previously unrecorded activity is not backfilled.

## Study-session lifecycle

A visit begins when the server establishes a logical guest's presence in a room. `StudySessionService` observes the existing guest-keyed presence list and assigns one in-memory visit UUID. It creates the database record through its ordered persistence queue. A first guest also begins the room's gathering.

The existing `guestId -> Set<socketId>` model remains unchanged:

- Rejoining with another socket while the logical guest still exists reuses the visit ID.
- A second tab adds a connection to the same guest and does not add a visit or duplicate focus time.
- Losing one of multiple sockets leaves the guest connected.
- Losing the final socket stops focus accrual immediately, but retains the visit through **15 seconds of grace after disconnect detection**. Returning during grace continues that visit.
- Explicit Leave of the final socket, grace expiry, or clean shutdown ends the visit. A zero-focus visit remains a valid record.
- The room gathering remains open until its last logical guest leaves, including grace. One member leaving cannot reset another member's current gathering duration.
- Once grace has expired, returning begins a new visit. Changing rooms ends the previous visit according to the existing leave/disconnect path and starts another in the destination.

Visit duration is elapsed room time, including idle time, pauses, breaks and reconnect grace. Focus time is a separate measurement. Current room gathering duration and the previous gathering duration appear in room Stats, as of the last refresh.

## Focus accounting

The existing authoritative Pomodoro retains its 25-minute focus / 5-minute break state machine. A small transition observer receives the previous state, next state, reason and authoritative transition time. There are no browser-submitted focus totals and no rewritten timer controls.

Each connected visit has a focus interval anchor only while the room timer is `phase: focus` and `status: running`. A pause, reset, completion, presence change, periodic checkpoint or explicit stats refresh settles that interval using server timestamps. Its end is capped at the timer's authoritative deadline, so a delayed completion callback cannot count extra time. Resume begins a new interval. Positive intervals accumulate in milliseconds; `focus_seconds` is derived without rounding each small interval away.

Idle time, paused time, short breaks and time after the final socket disconnects do not accrue focus. A guest's descriptive status (Coding/Reading/Break/etc.) does not control the shared timer or independently change focus accounting. Focus stops/starts according to the timer and connection state.

Writes occur on joins/presence transitions, timer changes, visit end, explicit Stats refresh and a **60-second checkpoint**. There is no per-second SQL loop. Checkpoints operate only on active visits; room-specific changes checkpoint that room. The Stats view makes a bounded set of HTTP reads on opening/reconnecting/refresh and uses a cursor to load earlier sessions. Ordinary React rerenders do not query history. A static Updated timestamp makes the refresh behavior visible.

## Pomodoro completion rule

The authoritative timer's single completion transition determines a completed focus cycle. Each focus cycle has a server-generated UUID. Only guests with a positive credited focus interval during that cycle receive a completion. A guest can join late or leave before the cycle ends and still have contributed; there is no minimum-participation threshold in V1.

Each guest receives **at most one completion for a shared focus cycle**. If they end one visit and begin another before the same timer finishes, credit goes to their latest contributing visit. Different tabs never add another credit. Contributors who left earlier can receive the completion on their already-ended visit when the shared timer finishes. The activity date is the actual timer completion time.

The timer already rejects duplicate controls and stale completion callbacks. The service clears a completed cycle, and PostgreSQL's activity key also rejects a replay of the same session/cycle event. Reset preserves partial focused time but grants no completion. Finishing a short break grants no Pomodoro. On backend restart the active timer resets as before, so an interrupted cycle is not awarded a completion.

Personal totals count that guest's credits. Room Pomodoros count **distinct completed shared cycles**, rather than summing every participant's credit. Room focus is summed member time: two guests focusing together for ten minutes contribute twenty member-minutes.

## Task completion rule

An authoritative `incomplete -> completed` transition earns one contribution for the requesting guest's active study visit. The socket handler derives that visit/guest from current server membership and captures the request time. Client-supplied attribution is ignored.

The existing room repository writes the task and its study activity/counter inside the **same PostgreSQL transaction**. The study activity's task UUID is unique per visit. Therefore:

- Repeating `completed: true` adds nothing if the task is already complete.
- Completing, uncompleting and recompleting the same task in the same visit earns one contribution total.
- A different guest or a later visit can earn a contribution if it makes a genuine incomplete-to-completed transition.
- Deleting a task preserves its historical contribution.
- A failed transaction saves neither the task change nor its contribution.

Task completion also advances the open visit/gathering checkpoint. Personal cards say Tasks completed; the room card says Task contributions to distinguish contributions from the number of distinct task rows.

## Checkpoints, failures and restart recovery

`PostgresStudySessionRepository` uses the existing connection pool and checked-out transaction clients. Activity insertion and counter increments commit atomically. The in-memory queue keeps a failed batch, including its original deduplication IDs, and retries on subsequent events/checkpoints. SQL errors are logged with safe error codes, without credentials. Unavailable stats display a retryable UI message.

At backend startup, a PostgreSQL advisory lock reserves study tracking for this database/schema. A second live backend is rejected before it can close the first backend's visits. This intentionally preserves the application's single-backend architecture. The lock uses one reserved pool connection and releases automatically when its database connection dies; normal shutdown also releases it explicitly. If that ownership connection fails, new accounting writes stop and the log directs a backend restart.

After acquiring ownership, startup closes previously open visits and gatherings at their **last successful checkpoint**, marking visits `server_restart`. Their counters and activity remain. Reconnecting clients keep their persistent guest IDs but begin new visits because the old server's timer/presence are gone. A clean shutdown attempts a final accounting flush and closes visits before draining the pool.

An abrupt crash can lose activity not yet committed since the last successful checkpoint, normally up to about one minute of focus. A database outage can extend that window, and an uncommitted completion can also be lost. V1 does not infer offline focus or resume a timer across a backend restart. Saved history remains valid, and stale visits do not remain permanently open.

## HTTP endpoints and access scope

Historical data uses HTTP through the existing `/api` Vite proxy:

| Endpoint | Result |
| --- | --- |
| `GET /api/stats/me?timezone=Asia%2FManila` | Current guest's Today and All time focus/Pomodoro/task totals, overall visit count, timezone and as-of time. |
| `GET /api/stats/me/sessions?limit=10&cursor=...` | Current guest's recent visits, room names, focus/counts, start/end/duration, end reason and next cursor. Default 10, maximum 50; ordered by start time and UUID. |
| `GET /api/rooms/:roomId/stats` | Joined room's summed focus, distinct shared Pomodoros, task contributions and current/previous gathering durations. |

Today uses the browser's IANA timezone. The server validates the timezone and derives local midnight boundaries in PostgreSQL, including daylight-saving transitions. Focus intervals are split by overlap with that local day. Task/Pomodoro activity counts on the day of the event. Timestamps are stored as `timestamptz` and formatted locally by the UI.

The client requests a short-lived token with Socket.IO `stats:access { roomId }`. The server verifies joined membership, checkpoints current activity, and returns `{ ok: true, token }`. HTTP sends `Authorization: Bearer <token>`. The token scopes the guest and room on the server; the API never selects personal history from a caller-supplied guest ID. Tokens are revoked on leave/disconnect, reissued after reconnect, and never persisted. Responses use `Cache-Control: no-store`. Revocation is checked again after a database read.

Missing/revoked tokens receive 401; invalid timezone/cursor/limits and another-room requests receive 400; missing rooms receive 404; database failures receive 503. Room APIs return aggregates, not other guests' personal visit lists.

This is still guest identity, not account authentication: someone deliberately impersonating a known guest ID at the socket layer is outside V1's identity guarantees. Personal history is specific to the local browser identity, cannot follow another device automatically, and requires joining a room to obtain access. Clearing browser storage creates a new guest. No accounts, Redis, leaderboards, streaks, badges or chart packages were added.

## Validation and manual tests

Final validation passed **66 regular tests**, **6 PostgreSQL integration tests**, and both production builds. No lint command is configured. A deterministic concurrency regression also proves that Stats waits for queued accounting transactions to commit before reading history.

Deterministic clock tests cover the actual production 25/5-minute durations without waiting thirty minutes or shortening application timers. They exercise pause/resume/reset/break exclusions, late completion callbacks, same-guest multiple visits within one cycle, one-minute checkpoint frequency, retry batches, idle visits and reconnect continuity. PostgreSQL tests cover idempotent activity/counters, midnight overlap, cursor pagination, task contributions/deletion, privacy scopes, graceful visit end and stale recovery/ownership.

Browser verification used two independent Chromium profiles plus a same-identity tab, an actual backend crash/restart, and a separate test-database schema. It also verified that Stats stays connected, existing room features work, and desktop/mobile layouts fit.

1. Join `/r/history-study` as kei in a normal browser and mika in an incognito/separate profile. Open Stats. Expect one current visit per guest, zero focus while the timer is idle, and separate personal totals.
2. Refresh kei, briefly take that browser offline/online, and open a second kei tab. Expect the same current visit, one logical kei member and no duplicated focus. Close the second tab; the first remains active.
3. Start the shared focus timer, wait a short interval, pause, then open/refresh Stats. Both connected guests should have that interval of focus. Wait while paused and refresh: focus must not grow. Resume, wait, then reset: partial focus remains and no Pomodoro is awarded.
4. Complete a full focus cycle. Each contributing guest gets one personal Pomodoro and the room gets one shared Pomodoro. Reconnect or sync near completion: totals must not increment again. Break time adds no focus/Pomodoro.
5. Create a shared task as kei; complete it as mika. Mika earns one task contribution, kei earns none, and room contributions rise by one. Uncomplete/recomplete it repeatedly in mika's same visit; the stat stays at one. Delete the task; the contribution remains.
6. Explicitly Leave kei, then join another room and open Stats. The old visit is ended, personal history includes it, and the new room's aggregates are independent. Idle zero-focus visits should still appear. Closing all tabs instead ends the visit after disconnect detection and fifteen-second grace.
7. Use separate app terminals. Pause/reset or Refresh stats to checkpoint, stop only the backend, then restart it. Saved totals/tasks return, the old visit is closed at its checkpoint, and the new visit is in progress. There is one logical guest per profile. The timer and ephemeral chat reset as before.
8. With enough prior visits, open Stats: the first request contains ten rows. Load earlier sessions appends the next page without duplicates. Change another user's status while Stats is open; it should not refetch history on every presence rerender.
9. Verify Room/Tasks/Members/Settings navigation, task realtime sync, status updates, chat in both directions, local reactions, invite links and mobile layout. Check the browser console for application errors.

## Files changed in this milestone

| Area | Files |
| --- | --- |
| SQL and contract | new `server/db/migrations/003_study_sessions.sql`, new `shared/stats.d.ts`, `shared/presence.d.ts` |
| Database accounting | new `server/src/db/studyActivity.ts`, new `server/src/repositories/studySessionRepository.ts`, new `server/src/repositories/postgresStudySessionRepository.ts` |
| Runtime and HTTP | new `server/src/services/studySessionService.ts`, new `server/src/services/statsAccess.ts`, new `server/src/routes/stats.ts`, `server/src/index.ts`, `server/src/app.ts` |
| Existing realtime integration | `server/src/socket/roomTimer.ts`, `server/src/socket/index.ts`, `server/src/socket/persistentRoom.ts`, `server/src/repositories/roomRepository.ts`, `server/src/repositories/postgresRoomRepository.ts` |
| Stats UI/navigation | new `client/src/features/stats/StatsView.tsx`, new `client/src/features/stats/useStudyStats.ts`, new `client/src/styles/stats.css`, `client/src/styles/index.css` (keyboard skip link), `client/src/components/layout/Navbar.tsx`, `client/src/features/room/RoomPage.tsx` |
| Tests/docs | new `server/test/studySession.test.ts`, new `server/test/database/studyStats.test.ts`, `server/test/database/persistence.test.ts`, `README.md`, new `docs/study-stats-v1.md` |

Pre-existing working-tree edits from earlier milestones are preserved. No other project's state, production database, or Git history is changed by these tests.
