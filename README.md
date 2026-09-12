# Constellate

A cozy shared study room built with React, TypeScript, Express, and Socket.IO.

The current milestone makes room connections and presence reliable while preserving the existing UI, member statuses, shared Pomodoro timer, and room chat. Rooms are created in memory when their first member joins. `/r/demo` and `/r/test-room` use the same reusable route; existing `/room/...` links remain supported. Both route forms extract the same room ID (`demo`, for example). The server namespaces its Socket.IO channels as `room:demo`. Room IDs accept 1–64 letters, numbers, hyphens, or underscores, starting with a letter or number.

## Run locally

```sh
npm install
npm run dev
```

Open `http://localhost:5173/r/demo`. The API runs at `http://localhost:3000`; `GET /api/health` returns `{"status":"ok"}`. `http://localhost:5173/api/health` reaches the same API through Vite. Both processes are required. To run them in separate terminals, use `npm run dev:client` and `npm run dev:server` from the repository root. In PowerShell environments that block `npm.ps1`, use `npm.cmd` in place of `npm`.

If the frontend is already running on 5173 but the room cannot connect, start only `npm run dev:server`. Starting a second `npm run dev` fails on the occupied frontend port and stops its companion backend process. Check `/api/health` to confirm the backend is available before reloading the room or clicking Reconnect.

Defaults work without environment files. To customize them, copy `client/.env.example` to `client/.env` and `server/.env.example` to `server/.env`.

- Leave `VITE_SERVER_URL` empty for same-origin connections. Vite proxies `/socket.io` (polling and WebSocket upgrades) and `/api` to `SERVER_PROXY_TARGET`, defaulting to `http://127.0.0.1:3000`. This avoids directing a remote browser to its own localhost. Remove an old `VITE_SERVER_URL=http://localhost:3000` override to use the new default.
- `PORT` sets the backend port. If changed, also update `SERVER_PROXY_TARGET` in `client/.env`. Restart both dev processes after environment changes.
- `CLIENT_ORIGINS` is the comma-separated allowlist used for both polling CORS and WebSocket handshakes. Defaults allow `http://localhost:5173` and `http://127.0.0.1:5173`. Add the exact frontend origin when using a LAN address or another hostname; the proxy intentionally preserves the browser's Origin header. Vite uses port 5173 strictly so a busy port produces a clear error rather than silently moving to an unlisted origin.
- For a deployed frontend with a separate backend, set `VITE_SERVER_URL` to the reachable backend origin at build time and allow the frontend origin in `CLIENT_ORIGINS`. For same-origin deployment, the hosting reverse proxy must forward `/socket.io` including WebSocket upgrades to the backend. The Vite development proxy is not included in static build output.
- In development, the browser console logs `connected`, `disconnected`, `reconnecting`, `joined room`, and `room error` with useful context. These application logs are disabled in production. Check the two health URLs above when diagnosing an unavailable backend or proxy target.

## Presence behavior

- `client/src/services/socket.ts` owns one Socket.IO client per tab. `roomConnection.ts` owns acknowledged joins, connection state, bounded retries, and lifecycle cleanup. `useRoomPresence` registers member listeners once per room/identity and removes those exact listeners on cleanup, including React StrictMode remounts.
- `constellate_user_id` is created in localStorage on first opening. `constellate.identity` holds the existing `{ userId, nickname, avatar }` profile after the unchanged join dialog is completed. Existing profiles migrate without changing identity. IDs survive refresh and reconnect. Generation also works on LAN HTTP pages where `crypto.randomUUID` is unavailable.
- **Identity decision:** regular tabs at the same origin share one guest and one desk. This preserves the requested persistent browser user ID and the existing architecture. To see two members, use a regular window plus an incognito window or another browser profile. Two same-origin regular tabs intentionally do not count as two users. Distinct guests per tab would require a separate session identity policy.
- Shared event types live in `shared/presence.d.ts`. This declaration-only contract is consumed by both builds without introducing a shared runtime package.
- `room:join` reuses the existing payload `{ roomId, user: { id, nickname, avatar } }`: `user.id` is the persistent user ID and `nickname` is the display name. Successful joins acknowledge `{ ok: true }`; failed joins acknowledge `{ ok: false, error }`. It joins the room and broadcasts a full `presence:list { roomId, members }` to every room peer for a new, changed, or returning member. Idempotent joins send the snapshot just to the requester. Existing `presence:joined` events remain supported. A first-time member defaults to `coding`; rejoining restores their server status.
- `status:update` accepts `{ roomId, userId, status }` with `coding`, `reading`, `writing`, `studying`, `break`, or `dying`. The server rejects every other value and checks the socket's joined room/user metadata and its membership in that user's socket Set. Only status changes; nickname, avatar, desk, connected time and connection tracking stay intact. `presence:updated` broadcasts `{ roomId, member }` to everyone in that room, including the sender and their other tabs.
- Only your own Members row has a status dropdown. `useRoomPresence.updateStatus` immediately overlays the choice on your row and desk while retaining authoritative server state underneath. Acknowledgements clear the overlay; rejection restores the latest server status and displays an error. Older acknowledgements cannot overwrite newer choices. A timeout reconnects for a fresh snapshot. Disconnected controls are disabled and choices are never queued offline.
- A small in-memory map remembers the last selected status per room/user even after disconnect grace removes active presence. Rejoining within grace also keeps `connectedAt`. Rejoining after grace creates a new presence entry with the remembered status. Status memory is cleared on server shutdown and does not retain offline members or session history.
- The server stores `Map<roomId, Map<userId, { member, sockets, removal }>>`. Each user's active sockets are held in a Set. Losing one connection does not remove their other connections.
- After the final socket disconnects, removal waits **eight seconds from detection**. During grace the record has `connected: false`, but remains counted and retains its desk. A rejoin cancels removal, sets `connected: true`, and preserves the desk, status, and `connectedAt`. Otherwise the server emits `presence:left`, frees the desk, and broadcasts a full `presence:list`. Empty rooms are deleted. An explicit `room:leave` removes only that connection and removes the member immediately if it was their last connection.
- Each Socket.IO `connect`, including reconnects, sends a fresh `room:join`. The full list replaces stale local state. The UI reports connected only after successful acknowledgement. It preserves the last snapshot while reconnecting. A join acknowledgement has a five-second timeout and up to three total attempts on the existing socket, without reconnect loops. Transport failures use Socket.IO backoff (1–5 seconds, ten retries). Exhausted retries, rejected joins, or a server-forced disconnect show a small **Reconnect** action using existing styling. Stale acknowledgements and scheduled retries cannot update an unmounted room. Browser unload closes the transport and uses server grace; explicit navigation leaves immediately.
- `room:error` reports malformed payloads. Status errors carry `operation: 'status:update'` so they do not mark a healthy room connection as failed. Typed join/leave/status acknowledgements return `{ ok: true }` or `{ ok: false, error }`; raw clients without an acknowledgement are also handled safely.
- Members contain `{ userId, nickname, avatar, status, connectedAt, connected, deskId }`. Socket IDs remain in the server's per-user Set, so one tab closing cannot remove another active connection. The server assigns `desk-1`, `desk-2`, or `desk-3`; overflow members have `deskId: null` and remain in the sidebar. Remaining occupants never shift positions when someone leaves. The earliest connected waiting guest takes a freed desk. The scene renders by server desk ID using the existing artwork and status labels.

This is anonymous, single-server, in-memory state. A server restart clears rooms, remembered statuses, timers and chat history; connected clients rejoin automatically while their retry budget remains, or with Reconnect afterward. Desk continuity is guaranteed during grace on the same server, not across restart or grace expiry. Task, reaction, and room-title controls remain local demo behavior. No database, authentication, shared tasks, live reactions, voice, or microphone functionality is included. The existing Pomodoro and chat implementation was preserved; this milestone does not add advanced timer synchronization.

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

1. Run `npm run dev` from the repository root. Confirm both processes start. Visit `http://localhost:5173/api/health`; it should return `{"status":"ok"}` through the same proxy used by the room.
2. **A — First guest:** open `http://localhost:5173/r/demo` in a regular window. On first use, enter **kei**, select an avatar, and click **Join room**. Expect Members **1**, kei at desk 1, two empty desks, and no reconnecting room/chat message. Saved guests join automatically.
3. **B — Second guest:** open the identical URL in an **incognito window or a different browser profile**, enter **mika**, and join. Both windows should immediately show Members **2**, kei at desk 1, and mika at desk 2. A second regular tab shares kei's identity and intentionally keeps the count at 1 if no independent guest has joined.
4. **C — Leave:** close mika's window. Kei should retain mika and the desk during grace. Roughly **eight seconds after the server detects the disconnect**, Members becomes **1** and desk 2 becomes empty. For an abrupt network failure, Socket.IO's heartbeat detection time is additional to grace.
5. **D — Refresh:** refresh kei's tab. It should reuse the saved identity, return to Members **1**, and keep desk 1 if it rejoins within grace. Rejoin as mika and repeat kei's refresh with both windows open: neither should show a duplicate kei or a moved desk.
6. **E — Isolation:** open `http://localhost:5173/r/test-room` in another regular tab. It should contain only kei, not mika from demo. Return to demo and confirm its two-member list is unchanged. `/room/demo` remains an alias of `/r/demo`.
7. **Shared identity:** open a second regular tab at `/r/demo`. Both kei tabs share one member/desk. Close one kei tab; kei must remain visible to mika. Close the last kei tab; kei leaves after grace.
8. **Connection recovery:** with two independent guests present, briefly toggle one tab offline and online in developer tools. It should reconnect, rejoin once, and recover the latest members and chat. If retries are exhausted, restore the backend/network and click **Reconnect**. Stop the backend to exercise failure feedback; restart it and verify automatic recovery or the Reconnect action. Observe development-only lifecycle messages in the console.
9. **Stable desks and overflow:** join using four independent browser profiles/storage contexts. All four appear in Members, while exactly three desks are occupied. Close the guest at desk 1: after grace, the waiting fourth guest takes desk 1, and guests at desks 2 and 3 stay in place.

To verify statuses, keep kei and mika open in separate profiles. Both Members rows and occupied desks should show an icon and label. Set kei to **💻 Coding** and confirm mika updates immediately. Set mika to **📖 Reading**, then **☕ Break**, and confirm kei sees both changes without refreshing. Also check **✍️ Writing**, **📚 Studying**, and **😵 Dying**; dying keeps the existing slumped pose and Z indicator. Each window should expose only one editable selector. Refresh mika and verify one member retains the same desk and status. Open `/r/test-room` and confirm demo's changes do not appear there. Open a second kei tab, change status from either tab, and check all demo views agree with one kei member. Briefly disconnect/reconnect and confirm the server restores the selection.

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
npm test
npm run build
```

The integration tests use disposable local servers and cover health/CORS, full and incremental lists, duplicates, room isolation/switching, explicit leaves, refresh/rejoin grace, multiple sockets per user, malformed wire payloads, and rooms with more than three members. Status tests cover all four values, room broadcasts, same-user tabs, field preservation, ownership rejection, disconnect tracking, status restoration before/after grace, room-scoped status memory, and reset on a fresh server. Timer tests cover authorization, concurrent starts, fresh join/rejoin/sync snapshots, room isolation, pause/resume/reset, event traffic, both phase completions, stale timeout cancellation and shutdown cleanup. Chat tests cover canonical IDs, sender spoofing, validation boundaries, authorization, room isolation, join/rejoin history, the 100-message cap, shared-user rate limits and expiry, safe rejection and disposal. Node's built-in mock clock exercises the real timer durations and chat rate window. Presence tests use a shorter injected grace period for speed; the application default is eight seconds. No additional test framework is installed.

Additional presence coverage exercises the actual Vite proxy with real Socket.IO clients, polling-to-WebSocket upgrades, acknowledged joins, existing timer/chat snapshots, automatic transport reconnection, and room isolation. Client lifecycle tests cover bounded acknowledgement retries, stale callbacks, listener cleanup, and StrictMode-style remounts. Identity tests cover first opening, legacy profile migration, shared browser identity, and non-secure-context ID generation. Rendered component checks verify server desk mapping, empty slots, overflow members, member counts, and the retry action. These checks do not replace an interactive browser run of A–E above.

## Files changed for the presence milestone

| Area | Files |
| --- | --- |
| Run commands and documentation | `package.json`, `server/package.json`, `README.md` |
| Client configuration and routes | `client/.env.example`, `client/vite.config.ts`, `client/src/App.tsx`, `client/src/main.tsx` |
| Socket lifecycle | `client/src/services/socket.ts`, `client/src/services/roomConnection.ts` (new) |
| Identity and member state | `client/src/features/presence/localIdentity.ts`, `client/src/features/presence/useRoomPresence.ts`, `client/src/features/presence/MembersPanel.tsx`, `client/src/features/presence/statusOptions.ts` |
| Room and desks | `client/src/features/room/RoomPage.tsx`, `client/src/features/room/RoomScene.tsx`, `client/src/features/room/StudyDesk.tsx` |
| Presence protocol and server | `shared/presence.d.ts`, `server/src/socket/index.ts`, `server/src/socket/roomPresence.ts` |
| Existing tests extended | `server/test/presence.test.ts`, `server/test/roomChat.test.ts` |
| New tests | `server/test/clientConnection.test.ts`, `server/test/clientIdentity.test.ts`, `server/test/devConnection.test.ts`, `server/test/presenceView.test.tsx` |
