# WebRTC voice room V1

Voice is optional and audio-only, added to the existing Members panel. Normal room creation/join, presence, statuses, timer, tasks, chat, reactions and stats still use the existing room connection and do not require microphone permission. No application redesign, video, screen sharing, recording, audio uploads, SFU or paid voice service was added.

## Join, leave and microphone privacy

**Join Voice** is the only path to `getUserMedia`. It requests the browser's default audio input with compatible echo cancellation, noise suppression and automatic gain controls; `video: false` means no camera request. Unsupported/insecure contexts, denied permissions, missing devices and busy/device errors show a compact message while the rest of the room remains usable.

The stream stays in the browser controller. It is never serialized into React application data, localStorage, PostgreSQL or Redis. Audio tracks are disabled until the server confirms this tab's voice ownership. Cancel/unmount during a delayed permission request stops any stream that resolves afterward. The microphone's `ended` event leaves voice and prompts a new explicit join.

**Mute** sets local audio `track.enabled = false`; **Unmute** sets it true. No offer/answer renegotiation is needed. A logical mute-state message updates other Members rows. Muted guests stay in voice; the microphone device can remain open while muted. **Leave Voice** stops the input tracks, closes every peer, removes remote audio elements/streams and sends a room-scoped leave. The study room stays open. **Leave Room** awaits voice cleanup before the ordinary room leave.

Each browser starts idle after refresh. There is no saved automatic-voice flag and no microphone reacquisition on page load. Existing room recovery may restore the study room; voice still requires Join Voice again.

## Connection establishment and peer management

The browser has one `VoiceRoom` controller per joined room/guest, connected through the existing singleton Socket.IO client. `useVoiceRoom` owns controller lifetime and passes small UI snapshots to `VoiceControls`. Media objects and a `Map<guestId, Peer>` stay outside React state. Each remote voice guest has exactly one `RTCPeerConnection`, one hidden audio output and bounded negotiation work/candidate storage.

After an authorized join, Redis returns the current voice roster and a server-issued voice session UUID. For each pair, **the lexically smaller guest ID initiates the offer** using JavaScript string ordering. The other guest sets that remote description and answers. Both exchange ICE candidates. This deterministic rule avoids simultaneous offer collisions without a full perfect-negotiation implementation.

Every negotiation has its own UUID, in addition to sender/target voice-session UUIDs. A reply or ICE candidate from an old session cannot attach to a fresh peer. Candidates arriving before the remote description are queued (64 per peer); bounded early signaling waits for the appropriate roster. On a new negotiation, matching early candidates carry into the replacement connection. Async operations check that the peer/controller is still current before applying results.

`ontrack` attaches the remote stream to its one `HTMLAudioElement` and calls `play()`. The local stream is never played locally. If browser autoplay rejects playback, the existing panel offers **Enable audio**, which retries playback from a direct user gesture. Leaving/removing a peer pauses and removes its output, clears the source and stops remote tracks.

WebRTC transports the actual audio between browsers (or through a future TURN relay). Socket.IO transports only bounded SDP/ICE signaling. Redis Pub/Sub carries those Socket.IO events across Node instances; neither Node nor Redis receives microphone media packets.

## Events and authorization

Shared types are in `shared/voice.d.ts` and integrated into `shared/presence.d.ts`.

| Event | Direction | Purpose |
| --- | --- | --- |
| `voice:join` | Client → server, acknowledgement | `{roomId, clientId, muted}`; require joined membership, atomically claim guest voice ownership, return session ID/roster |
| `voice:leave` | Client → server, acknowledgement | `{roomId, clientId}`; remove only this exact owning socket/client nonce |
| `voice:participants` | Server → joined room | Guest ID, nickname, mute, voice-session ID, room generation/revision; no internal socket/client nonce |
| `voice:mute-state` | Client → server, acknowledgement | `{roomId, sessionId, muted}`; update only this voice owner's logical mute state |
| `voice:offer` | Client → server → target socket | Audio offer plus sender/target session and negotiation IDs |
| `voice:answer` | Client → server → target socket | Matching audio answer |
| `voice:ice-candidate` | Client → server → target socket | Bounded ICE candidate metadata |
| `voice:restart` | Client → server → target socket | Ask the deterministic initiator for a bounded new negotiation |

Signaling requests carry `roomId`, the sender's `sessionId`, `targetGuestId`, `targetSessionId` and `negotiationId`. The server derives the sender from the socket's joined membership, verifies both voice owners and both live socket leases in the same room, then emits only to the target socket's Socket.IO room. A separate same-guest tab cannot send as the owner, mute it or steal it. Arbitrary extra sender fields are stripped. Cross-room, stale-session and no-longer-voice targets are rejected.

Descriptions must match the offer/answer event and fit 12,000 characters; video/data m-lines are rejected. Candidate strings are capped at 2,048 characters with bounded metadata. Socket.IO's whole-message bound is 16 KiB. Signaling is limited to 100 messages per three seconds for the one owning socket. Join/leave/mute share the room's sequential lifecycle queue, preventing a delayed Join from resurrecting ownership after Cancel. SDP/ICE is neither persisted nor displayed in the UI.

These checks provide room/ownership isolation within the existing anonymous guest architecture. A guest ID is still browser-provided, not an authenticated account. Public production access would require stronger identity/access controls. Peer-to-peer ICE inherently exchanges networking information between participants, though Constellate does not display it.

## Duplicate tabs, reconnect and failures

The normal persistent guest ID is the logical voice identity. Redis atomically permits **one active voice tab per guest per room**, even if its silent tabs connect to other backend instances. A different tab nonce gets “You're already connected to voice in another tab.” The UI can reject a known duplicate before opening its microphone; a simultaneous race is settled on the server, and the losing tab stops its temporary stream.

Temporary Socket.IO disconnect immediately disables local microphone tracks and closes local peers/audio. The controller keeps the existing usable input stream for at most **60 seconds**. Once ordinary room rejoin is acknowledged, the same tab nonce claims a new voice session/socket and rebuilds peers without calling `getUserMedia` again. Saved mute state is preserved through this short reconnect. A late old-socket leave cannot remove the new owner. If another tab has already claimed voice after the old ownership ended, rejoin is rejected and the old stream is stopped.

Known socket disconnect removes its voice ownership immediately even if a silent same-guest tab remains in the study room. An abrupt backend crash uses the shared **45-second socket lease**, checked on the five-second sweep or next room operation. Reconnecting the original tab can transfer its own nonce earlier; peers replace the old session rather than adding another guest. Normal room presence still has its separate 15-second grace period. A stale voice entry can briefly block a different tab until the old lease is cleaned up.

Peer setup has a 15-second timeout; a disconnected connection gets eight seconds to recover. Failed peers get at most two fresh negotiation attempts per participant session. The initiator rebuilds the connection/offer; the answerer requests a restart. Exhaustion closes the failed peer and gives a leave/rejoin/network-relay hint rather than retrying forever. Remaining room features and other voice peers continue working. If signaling remains offline for a minute, the microphone is stopped and the user must explicitly join again.

Cleanup runs on voice leave, whole-room leave, remote leave/session replacement, unmount, pagehide, disconnect and failed negotiation. It cancels peer/reconnect timers, closes connections, clears candidate/work maps, removes remote audio, stops appropriate tracks, and removes the controller's exact Socket.IO/window/track listeners. Disconnect is the one intentional exception to stopping local input immediately: it retains disabled tracks briefly for consent-preserving recovery.

## Redis and PostgreSQL

Voice is an ephemeral section of the shared room HASH described in the [Redis guide](redis-runtime-v1.md). Each guest's value contains owning socket ID, private browser-tab nonce, server voice-session UUID and mute flag. This lets two backend nodes enforce a single owner and route signaling to the right socket. It uses the existing socket lease and room TTL cleanup, not permanent PostgreSQL rows. Public rosters expose only guest ID, nickname, mute and voice-session ID.

Redis contains **no raw audio, MediaStream, recording, SDP history or permanent ICE candidates**. PostgreSQL contains no active voice participation or voice-session history. The ordinary study visit/focus timer continues independently of whether the guest joins or mutes voice.

## ICE configuration and limitations

All ICE configuration lives in `client/src/features/voice/iceConfig.ts`. With no client environment override, it uses:

```ts
[{ urls: 'stun:stun.l.google.com:19302' }]
```

Optional `client/.env`:

```dotenv
VITE_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"}]'
```

The parser supports a JSON array (maximum eight entries) of standard `RTCIceServer` shapes, including arrays of URLs, `username` and `credential`. `stun:`, `stuns:`, `turn:` and `turns:` URLs are accepted. For example, an operator-provided relay could later supply:

```dotenv
# Illustrative values only; no relay is deployed by this milestone.
VITE_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":["turn:relay.example:3478","turns:relay.example:5349"],"username":"temporary-user","credential":"temporary-credential"}]'
```

`VITE_*` is public build-time browser configuration. Do not put private long-lived TURN credentials here. A production short-lived credential-issuing endpoint/refresh mechanism is a future task; static environment support alone is not a full TURN credential lifecycle. `VITE_ICE_SERVERS='[]'` is useful for local host-candidate tests and intentionally does not provide NAT traversal. Restart Vite/rebuild after configuration changes.

Localhost and some LAN/NAT arrangements work without TURN, and public STUN helps discover reachable candidates. STUN **does not guarantee** access through restrictive NAT/firewalls. Production voice reliability requires a TURN relay and HTTPS. This milestone does not deploy TURN or claim cross-network reliability.

`getUserMedia` requires a secure context, generally HTTPS or localhost. A plain HTTP LAN IP can be reachable for the study room yet lack microphone APIs; use HTTPS for that test rather than weakening browser security. Browser policies can also require the explicit Enable audio gesture. See [media permission/security rules](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) and [autoplay guidance](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay).

The mesh is deliberately capped at **six voice guests** (five peers each), with browser/network load growing per participant. V1 uses default devices and has no speaking indicator, device picker, recording, video or audio settings screen. Safari/Firefox/mobile browser and real-device/network quality have not been established by the Chromium synthetic-media suite.

## Exact run commands

In this already-configured Windows workspace, from the repository root:

```powershell
npm.cmd run db:start
npm.cmd run redis:start
npm.cmd run db:migrate
npm.cmd run dev
```

Open `http://localhost:5173/r/demo`. The backend is `http://127.0.0.1:3000`; both API and Socket.IO pass through Vite, with WebSocket upgrades enabled. If the existing client terminal is already running, start only `npm.cmd run dev:server` instead of a second Vite. The root command remains the normal future workflow.

On a fresh checkout, first run `npm.cmd install`, `npm.cmd run db:setup`, `npm.cmd run redis:setup`, then the commands above. The ignored `server/.env` needs `DATABASE_URL` and `REDIS_URL` and is already populated here. Voice needs **no additional .env file or SQL migration**. `client/.env` is optional only for changing ICE/deployment settings. Use the [Redis guide's exact three-terminal commands](redis-runtime-v1.md#two-backend-development-test) for two backend instances.

## Automated verification and what it proves

```powershell
npm.cmd test
npm.cmd run test:db
npm.cmd run test:redis
npm.cmd exec -- playwright install chromium
npm.cmd run test:browser
npm.cmd run build
```

The ordinary tests cover voice opt-in state, single-tab ownership, stale leave/session protection, lease cleanup, bounded audio-only signaling validation and ICE parsing alongside existing features. Redis integration verifies cross-node targeted signaling, unauthorized same-guest sockets, room isolation, mute ownership, join/cancel ordering and lifecycle. These server tests use sample SDP and **do not prove media playback**.

The Playwright suite separately launches two actual Node processes and two Vite proxies, creates isolated browser contexts, and generates a synthetic tone as Chromium's fake audio input. It checks connected native peer connections, received RTP bytes/decoded audio energy in both directions (all six directions for three guests), active audio output playback, silence after mute and resumed energy after unmute. It exercises leave/rejoin, duplicate tabs, disconnect, refresh, another room, permission denial, delayed permission cancellation, abrupt close, real Node restart, synchronized tasks/chat/reactions, Pomodoro/stats and responsive UI. It checks application exceptions and proxy errors while servers should be available. Test timer completion uses only an isolated fixture deadline; production durations are unchanged.

This never captures or records your microphone. It proves synthetic browser transport/decoding/output state in local Chromium, not physical audibility or device quality. Denial/cancel errors are injected for repeatability, not a claim that a human clicked a real permission prompt. Run the manual checks below with actual devices. Browser reports/screenshots are stored under ignored `.vite/`.

There is no configured lint command. The client and backend builds both run TypeScript checks. Tests use disposable test database schemas/Redis namespaces and clean up their own processes/data; they do not alter the development rooms.

## Exact manual browser checklist

Use headphones or separate devices to avoid acoustic feedback. Start services/app as above. Use a normal window as **A / kei**, a private window or separate profile as **B / mika**, and a third independent profile/device as **C / ari**. Separate private windows may share storage, so use distinct profiles/browsers when necessary. Open the same `http://localhost:5173/r/voice-check` URL (HTTPS for non-localhost devices).

1. **No automatic microphone:** Join the study room in A and B without Join Voice. Both appear in Members; there is no microphone request or voice peer.
2. **Explicit consent:** Click Join Voice in A. Permission appears only now if not already granted. Allow audio; A shows one in voice and microphone on. No camera request appears.
3. **Two-way audio:** Join Voice in B and allow audio. Speak separately; each hears the other once. Each sees one connected peer. Click Enable audio if offered.
4. **Mute:** Mute A. B stops hearing A and sees the muted icon. A can still hear B; both remain in voice.
5. **Unmute:** Unmute A. B hears A again without peer replacement or duplicate output.
6. **Voice-only leave:** Leave Voice in B. B stays in the study room, microphone capture stops, and A loses B's audio/voice indicator. Chat/tasks still work.
7. **Clean rejoin:** Join Voice again in B. One output per peer returns; repeat leave/join several times and check for doubled audio.
8. **Refresh:** Refresh A. The study room recovers its guest/desk, but microphone/voice do not restart. Click Join Voice explicitly to return.
9. **Temporary disconnect:** Briefly take A offline (DevTools Network Offline), then online within a minute. A shows paused/reconnecting voice; the microphone stream is reused on reconnect, with one voice guest/output. Staying offline beyond a minute stops the microphone and requires a new click.
10. **Same-guest tab:** Open another normal tab at the same URL as A. While A owns voice, Join Voice in that tab is rejected with the another-tab message. Ordinary Members still shows one kei. Close that silent tab; A remains connected.
11. **Room isolation:** Open a separate profile in `/r/other-voice-check` and join voice there. It cannot hear or receive signaling from the first room. Its timer/chat/tasks/presence also stay separate.
12. **Three-way mesh:** Join C to the first room and voice. Speak one at a time: each hears both others once, with two peers. Mute/leave/rejoin one participant and verify the other pair remains connected.
13. **Abrupt closure:** Close C's window. Its voice peer/output disappears from A/B. Ordinary member presence may retain C's desk during the separate grace period. Reopen C: voice stays off until Join Voice.
14. **Permission/device failure:** In an independent profile, deny the microphone. A clear message appears and no peers are created; continue using chat/tasks/timer. Also test a missing/busy input if available. Cancel a pending permission prompt, then grant it late: capture must not remain running.
15. **Study timer/stats:** Complete a focus Pomodoro while in voice, then open Stats. One completion per eligible guest and one room cycle appear, with no duplicate visit from reconnect. Voice stays connected on the Stats view. Pause/resume/reset and break do not inflate focus.
16. **Other features/cross-node recovery:** While talking, rename the room, use invite links, change statuses, send chat/reactions, add/complete/undo tasks and view personal/room stats. Repeat through the two different frontend origins in the Redis guide. Stop/restart only one Node while Redis stays up: the timer deadline recovers and usable local microphones reconnect without a new prompt. Browser console stays free of uncaught errors; steady-state Vite has no refused proxy connections.

## Changed files and packages

| Area | Files |
| --- | --- |
| Browser voice controller/hook/ICE | `client/src/features/voice/webrtc.ts`, `useVoiceRoom.ts`, `iceConfig.ts` |
| Compact UI integration | `client/src/features/voice/VoiceControls.tsx`, `client/src/styles/voice.css`, `client/src/features/presence/MembersPanel.tsx`, `client/src/features/room/RoomPage.tsx` |
| Configuration/types | `client/.env.example`, `client/src/vite-env.d.ts`, `shared/voice.d.ts`, `shared/presence.d.ts` |
| Server voice | `server/src/socket/voiceHandlers.ts`, `server/src/socket/sharedRoom.ts`, `server/src/redis/roomState.ts`, `server/src/redis/roomRuntime.ts` |
| Verification/workflow | `server/test/voice.test.ts`, `server/test/redis/runtime.test.ts`, `server/test/browser/voice.mjs`, root/server `package.json`, `package-lock.json` |
| Documentation | `README.md`, `docs/voice-v1.md`, `docs/redis-runtime-v1.md`, historical-guide notices |

Redis foundation changes and legacy test-fixture updates are listed in the [Redis guide](redis-runtime-v1.md#files-and-remaining-scope). Installed runtime packages are **ioredis** and **@socket.io/redis-adapter**; **playwright** is a development-only browser test dependency. Voice itself uses native browser WebRTC/media APIs and adds no media SDK. The existing concurrently workflow is retained. No commits or pushes are part of this milestone.
