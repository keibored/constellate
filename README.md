# Constellate

A cozy shared study room built with React, TypeScript, Express, and Socket.IO.

The current real-time milestone covers anonymous room entry, live presence, and live member statuses. Rooms are created in memory when their first member joins. `/room/demo` and `/room/stellar-fox-27` use the same reusable route. Room IDs accept 1–64 letters, numbers, hyphens, or underscores, starting with a letter or number.

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

This is anonymous, single-server, in-memory presence. A server restart clears rooms, and connected clients rejoin automatically. Existing timer, task, reaction, and room-title controls remain local demo behavior. No database, authentication, synchronized timers, shared tasks, or live reactions are included.

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

## Automated checks

```sh
npm test --prefix server
npm run build --prefix client
npm run build --prefix server
```

The integration tests use disposable local servers and cover health/CORS, full and incremental lists, duplicates, room isolation/switching, explicit leaves, refresh/rejoin grace, multiple sockets per user, malformed wire payloads, and rooms with more than three members. Status tests cover all four values, room broadcasts, same-user tabs, field preservation, ownership rejection, disconnect tracking, status restoration before/after grace, room-scoped status memory, and reset on a fresh server. They use a shorter injected grace period for speed; the application default remains four seconds. No additional test framework is installed.
