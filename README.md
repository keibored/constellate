# Constellate

A cozy shared study room built with React, TypeScript, Express, and Socket.IO.

The current real-time milestone covers anonymous room entry, live presence, live member statuses, a shared Pomodoro timer, and room chat. Rooms are created in memory when their first member joins. `/room/demo` and `/room/stellar-fox-27` use the same reusable route. Room IDs accept 1–64 letters, numbers, hyphens, or underscores, starting with a letter or number.

## Run locally

```sh
npm install
npm run dev
```

Open `http://localhost:5173/room/stellar-fox-27`. The API runs at `http://localhost:3000`; `GET /api/health` returns `{"status":"ok"}`.

Defaults work without environment files. To customize them, copy `client/.env.example` to `client/.env` and `server/.env.example` to `server/.env`. `VITE_SERVER_URL` sets the client connection URL. `PORT` sets the server port. `CLIENT_ORIGINS` is a comma-separated allowlist of frontend origins used for both polling CORS and WebSocket handshakes. Keep it in step with your Vite URL. Vite uses port 5173 strictly so a busy port produces a clear error instead of silently moving to an origin the server does not allow.

## Presence behavior

- `client/src/services/socket.ts` owns one Socket.IO client per tab. `useRoomPresence` registers listeners once per room/identity and removes those exact listeners on cleanup.
- `constellate.identity` in localStorage contains `{ userId, nickname, avatar }`. The UUID is generated at first entry and reused after refresh. Regular tabs at the same origin share that identity; use an incognito window or another browser profile to test a different user. No per-tab identity overrides are needed.
- Shared event types live in `shared/presence.d.ts`. This declaration-only contract is consumed by both builds without introducing a shared runtime package.
- `room:join` validates `{ roomId, user: { id, nickname, avatar } }`, joins a Socket.IO room, sends `presence:list`, and broadcasts `presence:joined` for a new or changed member. Repeated joins are idempotent. A first-time member defaults to `coding`; rejoining restores their server status.
- `status:update` accepts `{ roomId, userId, status }` with `coding`, `reading`, `break`, or `dying`. The server checks the socket's joined room/user metadata and its membership in that user's socket Set. Only status changes; nickname, avatar, connected time and connection tracking stay intact. `presence:updated` broadcasts `{ roomId, member }` to everyone in the room, including the sender and their other tabs.
- Only your own Members row has a status dropdown. `useRoomPresence.updateStatus` immediately overlays the choice on your row and desk while retaining authoritative server state underneath. Acknowledgements clear the overlay; rejection restores the latest server status and displays an error. Older acknowledgements cannot overwrite newer choices. A timeout reconnects for a fresh snapshot. Disconnected controls are disabled and choices are never queued offline.
- A small in-memory map remembers the last selected status per room/user even after disconnect grace removes active presence. Rejoining within grace also keeps `connectedAt`. Rejoining after grace creates a new presence entry with the remembered status. Status memory is cleared on server shutdown and does not retain offline members or session history.
- The server stores `Map<roomId, Map<userId, { member, sockets, removal }>>`. Each user's active sockets are held in a Set. Losing one connection does not remove their other connections.
- After the final socket disconnects, removal waits four seconds. A rejoin cancels removal and keeps the original `connectedAt`. Otherwise the server emits `presence:left` and deletes empty rooms. An explicit `room:leave` removes only that connection and removes the member immediately if it was their last connection.
- Each Socket.IO `connect`, including reconnects, sends a fresh `room:join`. The full list replaces stale local state. The UI shows reconnecting feedback while keeping the previous snapshot visible. Join acknowledgements have a timeout; stale acknowledgements are ignored after disconnect or cleanup.
- `room:error` reports malformed payloads. Status errors carry `operation: 'status:update'` so they do not mark a healthy room connection as failed. Typed join/leave/status acknowledgements return `{ ok: true }` or `{ ok: false, error }`; raw clients without an acknowledgement are also handled safely.
- All members appear in the sidebar; only the first three populate the fixed desks. Empty desks retain their artwork. Desk position, avatar, and user identity are separate.

This is anonymous, single-server, in-memory state. A server restart clears rooms, remembered statuses, timers and chat history; connected clients rejoin automatically. Task, reaction, and room-title controls remain local demo behavior. No database, authentication, shared tasks, or live reactions are included.

## Shared Pomodoro timer

- `shared/timer.d.ts` describes `RoomTimerState`: `phase` (`focus` or `shortBreak`), `status` (`idle`, `running`, `paused`), `durationMs`, `remainingMs`, `startedAt`, `endsAt`, and `revision`. Snapshots also include `roomId` and `serverNow`.
- `server/src/socket/roomTimer.ts` lazily creates each timer at **Focus / 25:00 / idle**. Timers remain in memory when everyone leaves so returning members recover the ongoing session. Only a server restart discards them.
- Clients request `timer:start`, `timer:pause`, `timer:resume`, `timer:reset`, or `timer:sync`, each with `{ roomId }`. The server verifies both socket membership metadata and the user's active socket Set. Malformed or unauthorized requests receive a failed acknowledgement and a `room:error` tagged with the timer operation; they cannot disrupt presence.
- For a running timer, each snapshot calculates `Math.max(0, endsAt - Date.now())`. Start/resume sets the server timestamps. Pause captures the remaining milliseconds and clears timestamps. Reset returns to Focus / 25:00 / idle from either phase.
- Each running room has one completion timeout. Pause/reset cancels it; resume schedules a fresh one. Revision and entry checks prevent an old callback from affecting a newer run. Completion switches **Focus → Break / 05:00 / idle**, then **Break → Focus / 25:00 / idle**. Neither phase starts automatically. A sync also settles an overdue completion if its callback was delayed.
- Node processes actions sequentially. A duplicate Start cannot replace the existing start/end timestamps or schedule another completion. Inapplicable transitions return current state without mutation. Canonical changes increment revision and broadcast `timer:state` once to the room, including same-user tabs. Sync and duplicate-action replies go only to the requester.
- Successful room joins always receive a freshly calculated timer snapshot. `useRoomTimer` reuses the existing socket, subscribes to one `timer:state` listener, and requests a sync after joining/reconnecting or returning to a visible tab. Older revisions on the same connection are ignored; a new connection accepts a fresh server's revision zero.
- The timer card anchors received `remainingMs` to `performance.now()` and renders at 250 ms intervals inside the focused hook. The user's wall clock does not control the countdown. Network latency can introduce a small sub-second difference. **No timer state is broadcast or requested every second.**
- Timer buttons wait for authoritative state, with a brief disabled state while awaiting acknowledgement. Offline controls are disabled and never buffered. An acknowledgement timeout reconnects for a fresh room/timer snapshot. The existing settings icon remains; durations are fixed at 25/5 minutes and the old local duration selector is read-only.

## Room chat

- `shared/chat.d.ts` defines `ChatMessage`: `{ id, roomId, userId, nickname, avatar, content, createdAt }`. IDs are server-generated UUIDs and `createdAt` is a numeric server timestamp. The client formats timestamps in local time.
- `chat:send` accepts only the needed data, `{ roomId, content }`. The handler verifies the socket's joined room/user metadata and retrieves the active member using that socket's membership. Sender ID, nickname and avatar come from that member; extra client-supplied identity, ID or timestamp fields are ignored.
- Content must be a string, is trimmed, and must contain 1–500 characters using JavaScript string length (matching the input's `maxLength`). Blank, malformed and overlong messages are rejected. React renders message content as plain text, including anything that resembles HTML.
- `server/src/socket/roomChat.ts` stores the latest **100 messages per room** and discards the oldest after that limit. Histories remain capped until server shutdown, including when a room empties. There is no database or persistent chat storage.
- A rolling rate limit accepts at most **five messages per three seconds per room/user**, shared across that user's tabs. Other users and rooms have independent allowances. Expired rate windows are pruned when a room sends messages, without another timer. Rejection neither stores a message nor disconnects the sender.
- Accepted messages broadcast once through `chat:message` to that Socket.IO room, including the sender. Joining/rejoining sends `chat:history { roomId, messages }` with the current room's recent history. Other rooms never receive those events.
- `useRoomChat` reuses the existing socket, with one history listener and one message listener. History replaces the local array; future messages append only when their ID is new. Client lists also retain at most 100 messages. Room changes clear local chat state and filter out events for another room.
- The compact sidebar form supports Enter or the Send button. It shows the server's canonical message with no temporary optimistic copy, clears the submitted draft only after a successful acknowledgement, and preserves a newer draft typed while awaiting that acknowledgement. Rejected messages retain the draft and show feedback. Offline drafts are not queued; an acknowledgement timeout reconnects to recover history without automatically resending.
- The constrained message area follows new messages only when the reader is within 48 pixels of the bottom. Scrolling up to read older messages prevents forced scrolling. Avatars, muted self-message accents and local timestamps use the existing room style.

## Manual verification

1. Run `npm run dev`; confirm both processes start and visit `http://localhost:3000/api/health`.
2. In a regular window, open `http://localhost:5173/room/stellar-fox-27`, enter **kei**, select an avatar, and join. One member and one character should appear; the other two desks remain empty.
3. Open the identical URL in an **incognito window**, enter **mika**, select pink hair, and join. Both windows should show two members and two populated desks without refreshing.
4. Close mika's window. After roughly four seconds from the detected disconnect, mika should disappear from kei's room. Reopen incognito, re-enter mika, and verify the return.
5. Refresh kei's tab. The saved identity should rejoin automatically with exactly one kei entry. A refresh that reconnects within the grace period should not remove kei from mika's room.
6. Open the same URL in a second **regular tab**. It should reuse kei's identity without another form. Close the first regular tab; kei must remain visible in mika's window. Close the final regular tab; kei should leave after the grace period.
7. Reopen kei. Briefly toggle that tab offline in browser developer tools, then online. Presence should recover automatically. Longer outages may remove kei after the server detects disconnection plus the grace period; reconnecting restores kei.
8. Open `/room/demo` as well. It is a separate room. Invalid or missing room IDs show the existing not-found screen.
9. Open more independent profiles if desired: everyone appears in Members, and the scene still has only three desks. Check the browser console for application errors.

To verify statuses, keep kei and mika open in separate profiles. Select **reading** in kei's own row: both windows should update kei's row and book pose immediately. Select **dying** for mika and check the slumped pose and Z indicator in both windows. Try **break** for the relaxed pose and closed laptop, then **coding** for the laptop and headphones. Each window should expose only one editable status. Refresh kei and verify the selected status survives. Open a second kei tab, change status from either tab and check all three views agree with one kei member. Close one kei tab and verify kei stays present. Briefly disconnect/reconnect, including longer than the grace period, and confirm the server restores the last selection.

To verify the shared timer:

1. Join the same room as kei and mika in separate profiles. Start as kei, wait ten seconds, and check the displays agree within roughly a second.
2. Pause as mika and wait five seconds: both displays should stay frozen. Resume as kei, then reset as mika; both should return to Focus / 25:00 / Start.
3. Start again, wait at least fifteen seconds, and join from a third independent profile. It should receive the current countdown. Refresh kei and briefly disconnect/reconnect; elapsed time and the single member entry should be preserved.
4. Open another kei tab and control the timer from either tab. Both tabs and mika should agree. Close one kei tab and verify kei remains present.
5. Open a different room (for example `/room/night-owls` alongside `/room/demo`). Its timer should remain independent. Try starting the same room from two users together; the second action must not restart the timer.
6. Watch the browser's Network → WebSocket messages while the countdown runs: timer state appears on actions and synchronization, with no per-second timer broadcasts. Check the console for application errors.
7. At focus completion, all users should see Break / 05:00 / Start. Start that break; completion returns everyone to Focus / 25:00 / Start. The automated clock tests cover both full-duration completions without waiting thirty minutes or changing production durations.

To verify chat:

1. Join `/room/demo` as kei and mika in separate profiles. Send **hello mika** with Enter, then **lock in 😭** from mika using Send. Each view should show exactly one copy of each message with matching sender details and timestamps.
2. Try spaces only and a message longer than 500 characters. The form blocks invalid sends and the server rejects malformed/overlong wire payloads without disrupting the room.
3. Refresh kei and join as ari from another private session. Both should receive the same recent history, with no duplicates. Open a second kei tab and send from either tab; all views should receive one copy.
4. Join `/room/night-owls` and send a message there. Neither live messages nor history should appear in demo. Switching rooms should replace the displayed history.
5. Send rapidly: the sixth attempt within three seconds should be rejected with feedback, preserving the draft and connection. Wait three seconds and retry. The limit applies across same-user tabs.
6. Fill enough history to scroll. Scroll upward, then receive another message: your reading position should remain. Return near the bottom and receive another: the log should follow it.
7. Disconnect/reconnect kei while another member sends. Rejoining should restore the current history once; offline drafts should remain unsent. Check desktop/mobile layout and the console, then verify status/desk updates and timer Start/Pause/Resume/Reset still work.

## Automated checks

```sh
npm test --prefix server
npm run build --prefix client
npm run build --prefix server
```

The integration tests use disposable local servers and cover health/CORS, full and incremental lists, duplicates, room isolation/switching, explicit leaves, refresh/rejoin grace, multiple sockets per user, malformed wire payloads, and rooms with more than three members. Status tests cover all four values, room broadcasts, same-user tabs, field preservation, ownership rejection, disconnect tracking, status restoration before/after grace, room-scoped status memory, and reset on a fresh server. Timer tests cover authorization, concurrent starts, fresh join/rejoin/sync snapshots, room isolation, pause/resume/reset, event traffic, both phase completions, stale timeout cancellation and shutdown cleanup. Chat tests cover canonical IDs, sender spoofing, validation boundaries, authorization, room isolation, join/rejoin history, the 100-message cap, shared-user rate limits and expiry, safe rejection and disposal. Node's built-in mock clock exercises the real timer durations and chat rate window. Presence tests use a shorter injected grace period for speed; the application default remains four seconds. No additional test framework is installed.
