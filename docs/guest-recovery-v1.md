# Persistent Guest Identity + Reconnect Recovery V1

> Historical milestone guide. Current runtime, restart, setup and voice behavior is documented in [Redis runtime V1](redis-runtime-v1.md) and [Voice V1](voice-v1.md); those supersede the process-memory descriptions below.

This milestone extends the existing guest-based presence model. It preserves room routes, guest names/avatars, PostgreSQL rooms/tasks, the synchronized Pomodoro and the room's visual design. The only added UI is a small Leave icon beside the room code and a room-code form used after leaving.

## Local identity and session storage

| localStorage key | Contents |
| --- | --- |
| `constellate_user_id` | Stable guest ID. The existing key is retained to preserve users and task attribution. New IDs are UUID v4, including the fallback for browsers without `crypto.randomUUID`. Existing valid legacy IDs are reused. |
| `constellate.identity` | Existing `{ userId, nickname, avatar }` profile. Nickname and avatar naming are unchanged. |
| `constellate.room_statuses` | `{ userId, rooms: { [roomId]: status } }`; saved authoritative status preferences, scoped by guest and room. |
| `constellate_last_room` | Last successfully joined room slug. Only validated slugs are stored/restored. |

`guestId` is still called `userId` in the existing client/server contract. It never comes from `socket.id`. UUIDs use cryptographic randomness; legacy profiles migrate without rotating their ID. Status is saved from the server's member snapshots/updates, so rejected or unconfirmed optimistic choices are not persisted as final state. Each join rereads local status, including updates observed by another tab.

Storage is local to the browser profile and origin. Private/incognito storage is separate. Clearing site data creates a new guest on the next visit. If browser storage is blocked, a small in-memory fallback keeps the current tab usable, but it cannot preserve identity across closing/reloading or share identity between tabs.

## Reconnect and authoritative recovery

`socket.ts` continues to own one Socket.IO client per tab. Socket.IO handles transport reconnects with its existing 1–5 second backoff and unlimited attempts while the page is active. The connection service does not create another socket or install listeners on every reconnect.

Each successful transport connection sends `room:join` with the same guest ID/name/avatar, room ID and optional saved `status`. After a successful join, future reconnects also send `restore: true`. Reloading the saved active room does the same. The server then:

1. Loads the room and tasks from PostgreSQL. Recovery uses an existing-room read; it cannot recreate a deleted room.
2. Checks that this asynchronous join is still current and that its socket remains connected.
3. Attaches the socket to the guest's room presence entry.
4. Sends current `presence:list`, `room:state`, `timer:state` and `chat:history`, then acknowledges the join.

The UI reports connected after acknowledgement. Existing task and timer hooks request fresh authoritative state as well; task revisions prevent a delayed response from replacing a newer snapshot. Existing listeners are removed on cleanup, and stale acknowledgements or delayed joins cannot revive a room after leaving/switching.

An acknowledged temporary PostgreSQL failure returns `retryable: true`. The connection service retries the join on the existing socket with a delay capped at five seconds. A silent join has a five-second acknowledgement timeout and at most three attempts, then shows Reconnect. Rejected joins and intentional server namespace disconnects also expose Reconnect rather than overriding the server's decision.

## Presence, multiple tabs and grace

The server retains `Map<roomId, Map<guestId, { member, sockets: Set<socketId>, removal }>>`. Its key is the guest ID, so changing Socket.IO IDs never creates another logical member. Joining the same room in a second regular tab adds a connection to the same Set and keeps one member and one desk. Closing or leaving one tab does not take the remaining connection offline.

Only the final socket disconnect starts **15 seconds of grace, measured from server disconnect detection**. The member remains listed with `connected: false` and keeps its desk. Rejoining cancels removal, restores `connected: true` and preserves `connectedAt` and the desk. The server broadcasts the current room list without a new `presence:joined` announcement for a guest returning within grace. If no socket returns, it removes the member, frees the desk and broadcasts the room's updated list. A hard network failure may require Socket.IO heartbeat detection before grace begins.

Status precedence is:

1. The current presence entry's status, including an active second tab.
2. The current server's remembered status for that room/guest.
3. The returning browser's saved status for that room.
4. `coding` for a guest with no previous preference.

An older tab therefore cannot overwrite another tab's active status during rejoin. On a fresh backend, the browser preference restores the status. Live presence, sockets, online flags and desk allocations remain entirely in memory; PostgreSQL schema and migrations are unchanged.

## Room restoration and explicit leave

Opening `/r/<slug>` or the existing `/room/<slug>` alias always uses that URL. Opening `/` resumes `constellate_last_room` if present; otherwise it shows the room-code form. `/join` always shows the form and does not automatically redirect. A new valid code creates a room through the existing creation-on-first-join behavior.

Click **Leave room** beside the room code, or use the home link, to:

1. Clear the saved active room if it still names the room being left.
2. Cancel this tab's join/reconnect callbacks.
3. Send `room:leave` and wait up to 1.5 seconds for acknowledgement before disconnecting.
4. Return to `/join`, retaining guest identity, profile and room-specific status preferences.

The server removes this socket immediately and removes the member if it was the last socket. If another tab remains in that room, the guest stays online there. Leaving an old room does not clear a different room most recently joined by another tab. Another active tab can save its room again on a future successful rejoin. Browser refresh/closure and temporary network loss keep last-room state. Navigation through Leave/home completes the explicit leave; manually changing the URL or closing a tab uses transport disconnect/grace.

When Leave is clicked offline, it cannot immediately reach the server. It still cancels local recovery and clears last-room state; server presence expires after detecting the lost final connection and waiting through grace. It never queues a leave to be replayed into a new room.

A deleted restored room returns `ROOM_NOT_FOUND` with a useful error and a Leave control. It stays in recovery mode across refresh so it cannot silently create an empty replacement. Choosing Leave clears that active-room reference. Invalid routes show the existing not-found screen with a link to choose a room. There is no room deletion UI or access-control system; deliberately joining a fresh valid code can still create a room.

## Backend restart

Connected pages keep trying while the backend is down. Once it returns, presence is rebuilt from connected guest IDs, each guest's saved status is restored, and names/tasks/completion are loaded from PostgreSQL. No nickname/avatar prompt is required for a saved profile. Desks are assigned according to the new server's join order, so desk position and connected-at time can change across restart.

The active Pomodoro still resets to Focus / 25:00 / idle on backend restart, and all browsers receive that same authoritative reset. Existing in-memory recent chat resets. Reactions retain their existing local behavior. This milestone does not persist timer sessions/chat, add authentication, add Redis or change multi-server hosting support.

## Commands and validation

No new dependencies, environment variables or SQL migrations are required. Keep the existing setup:

```powershell
npm.cmd run db:start
npm.cmd run db:migrate
npm.cmd run dev
```

Or start the app separately with `npm.cmd run dev:server` and `npm.cmd run dev:client` from the root, which makes a backend-only restart easier to test. Ports remain frontend **5173**, backend **3000**, PostgreSQL **5432**.

```powershell
npm.cmd test
npm.cmd run test:db
npm.cmd run build
```

The regular suite covers local session storage, legacy/UUID identity, blocked storage, status precedence, acknowledged Leave, retry cancellation, shared tabs, grace, room isolation and the existing timer/chat/proxy behavior. Real PostgreSQL tests also verify that recovery/task sync cannot recreate a deleted room. Both builds type-check; there is no configured lint script.

Two isolated Chromium contexts plus a shared-identity tab were exercised against disposable Vite/backend processes and a separate test-database schema. Browser checks covered refresh, network loss, backend restart, task recovery, status restoration, grace expiry, root restoration, explicit Leave, deleted/invalid rooms and existing features. Desktop and mobile layouts were checked.

## Manual verification

1. Open `http://localhost:5173/r/recovery-study` as **kei** in a regular browser (A), and as **mika** in incognito/a separate profile (B). Expect two members. Set kei to Reading; refresh A and verify exactly one kei with the same status.
2. Open a second regular tab (A2) at the same room URL. Expect two total members, not three. Change status in A2; A/B agree. Close A2; kei stays online through A.
3. Briefly take A offline using browser developer tools, then restore its connection. Keep B open. A should recover automatically with the same identity, members, current timer, saved room metadata and tasks. A task created by B while A was offline appears on return.
4. Close all kei tabs. B retains kei during grace, then removes kei about fifteen seconds after server disconnect detection. Reopen `/` in the same normal profile; it restores the room with the original guest ID. Reopening an explicit room URL also works.
5. Click Leave room in A. It returns to `/join`; `constellate_last_room` is cleared while `constellate_user_id` and profile remain. Open `/` or refresh the chooser: it must not redirect back. If A2 was still open, kei remains present there.
6. Join a different room through the chooser. Your ID remains the same, while its members, tasks and saved status are independent. Return to the first room and recover that room's preference.
7. Create two tasks and complete one. Stop only the backend, wait, then restart it. A/B reconnect without entering names again. Room name, task IDs, task completion and statuses return; there are no duplicate members. Both timers show the same reset state and recent chat is empty.
8. Start/pause/resume/reset the timer from alternating browsers. Create/complete/uncomplete/delete a shared task, send chat both ways, use reactions and copy an invite. Confirm these work as before and check the mobile layout/console.
9. In a disposable test room, deleting its database row and refreshing a browser already joined there should show the missing-room error without recreating it. The automated database suite performs this safely in its own schema. Try an invalid URL such as `/r/invalid!`; it should offer Choose a room.

## Files changed for this milestone

| Area | Files |
| --- | --- |
| Identity/session storage | `client/src/features/presence/localIdentity.ts`, new `client/src/features/presence/localSession.ts`, new `client/src/services/localStorage.ts` |
| Client connection lifecycle | `client/src/services/socket.ts`, `client/src/services/roomConnection.ts`, `client/src/features/presence/useRoomPresence.ts` |
| Restoration/Leave UI | `client/src/App.tsx`, `client/src/main.tsx`, `client/src/features/room/RoomPage.tsx`, `client/src/features/room/RoomInfoCard.tsx`, `client/src/components/layout/Navbar.tsx`, new `client/src/features/room/RoomLobby.tsx`, new `client/src/styles/session.css` |
| Server and contract | `shared/presence.d.ts`, `server/src/socket/validation.ts`, `server/src/socket/roomPresence.ts`, `server/src/socket/index.ts`, `server/src/socket/persistentRoom.ts`, `server/src/repositories/roomRepository.ts`, `server/src/repositories/postgresRoomRepository.ts` |
| Regression coverage | `server/test/clientIdentity.test.ts`, new `server/test/clientSession.test.ts`, `server/test/clientConnection.test.ts`, `server/test/presence.test.ts`, `server/test/helpers/testRoomRepository.ts`, `server/test/database/persistence.test.ts` |
| Documentation | `README.md`, `docs/persistence-v1.md`, new `docs/guest-recovery-v1.md` |

Earlier milestone edits in the working tree are preserved. No commit or push is part of this work.
