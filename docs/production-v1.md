# Production deployment and hardening V1

## Status and scope

The deployment configuration and hardening are implemented. Local verification uses the **compiled production app over HTTPS/WSS**, real PostgreSQL/Redis and synthetic audio. No production account, domains or credentials were supplied; **no live deployment or provisioned datastore is claimed**. Hosted acceptance below remains pending. No UI redesign, account system, media relay or major feature was added.

## Provisioning and first release

Root `render.yaml` defines a static frontend, Node backend, PostgreSQL 18 and Redis-compatible Key Value in Singapore. PostgreSQL/Redis deny public connections. Redis has persistence and `noeviction` because evicting pending accounting is unsafe. The blueprint selects paid, always-on resources; review the account's current cost estimate before creating them. Capacity is an initial baseline, not a load-test result. [Blueprint reference](https://render.com/docs/blueprint-spec).

1. Choose the account, resource names, region and actual frontend/backend HTTPS origins. Provider-assigned domains are sufficient; custom domains are optional.
2. Run the README verification commands against test services. Commit/push the validated files to the release branch of `https://github.com/keibored/constellate`, then import `render.yaml` as a Blueprint.
3. Confirm the resource names are new or intentionally target existing services. Matching names can update existing resources. Give staging separate names, database and Redis prefix.
4. The blueprint injects private `DATABASE_URL` and `REDIS_URL` connections into the backend. Enter `CLIENT_ORIGINS` as the exact frontend origin, e.g. `https://study.example.com`, without a slash. Enter frontend `VITE_SERVER_URL` as the API origin, e.g. `https://api.example.com`.
5. If assigned domains differ from the initial values, update both using the actual URLs, redeploy the backend and **rebuild/redeploy the frontend**. Do not assume resource names guarantee subdomains. Mismatched origins intentionally prevent browser access.
6. Confirm the pre-deploy migration command succeeds and `/api/ready` returns 200. Frontend/backend releases must remain compatible.
7. Confirm TLS certificates for both origins and complete any custom-domain DNS setup. Render terminates HTTPS/WSS at the edge and forwards to the HTTP Node listener. [WebSockets](https://render.com/docs/websocket), [static hosting](https://render.com/docs/static-sites).

Both builds run from the **repository root** to preserve workspaces/shared contracts. The frontend publishes `client/dist`. The backend starts `node server/dist/index.js`; SQL files remain in `server/db/migrations`. Node is pinned in `.node-version`. Use compiled code, not Vite preview, watchers, serverless functions or Windows local helpers. Automatic deployments are disabled for deliberate release after checks pass.

`sync: false` values are prompted on initial creation; later changes belong in service environment settings. Production ignores local `.env` files. Never put database/Redis URLs or permanent TURN credentials in public `VITE_*` values. The static frontend needs an explicit backend URL; blank only works with a separately configured same-origin API/WebSocket reverse proxy.

For another provider, use the same compiled build/migrate/start commands, private stores and readiness endpoint. Proxies must forward WebSocket upgrades for `/socket.io/`, preserve Origin, and allow idle connections longer than the 45-second heartbeat window (at least 75 seconds). Set `TRUST_PROXY_HOPS` to the actual trusted proxy path. Public datastore connections require provider-supported TLS with certificate verification: `rediss://` for Redis and verified PostgreSQL SSL/CA settings. Never disable certificate verification to make a remote store connect.

## Migrations and rollback

The release command `npm run db:migrate:production` runs compiled JavaScript, applies SQL in a transaction and serializes concurrent runners with a PostgreSQL advisory lock. Repeats are no-ops; checksums reject edited historical migrations. Failures roll back and exit nonzero. Startup separately validates migrations and refuses to listen if the schema is missing or outdated.

Migrate **before** moving traffic. `/api/ready` is the deployment health check, not merely an open port. [Render health-check behavior](https://render.com/docs/health-checks).

Future migrations must remain compatible with old/new code during rollout. Add new files; do not edit existing migrations or automatically run destructive down-migrations. Maintain PostgreSQL backups and rehearse restores. Rollback selects the prior frontend/backend release while retaining compatible schema changes. Reverting code does not revert data; incompatible changes need an explicit recovery plan.

Redis is required runtime state. Keep persistence and `noeviction`, and monitor memory. Memory exhaustion must surface as failed operations rather than silent data eviction. Full Redis data loss can lose recent pending accounting plus temporary chat/timers/presence; PostgreSQL retains committed rooms/tasks/history. Test restores in isolated environments.

## Socket.IO and lifecycle

Production uses **WebSocket-only** transport on client/server, avoiding polling session-affinity requirements. Redis Pub/Sub fans out events; reconnect performs `room:join` and reloads snapshots. This adapter does not provide Socket.IO packet replay/connection-state recovery. [Multi-node guidance](https://socket.io/docs/v4/using-multiple-nodes/), [Redis adapter](https://socket.io/docs/v4/redis-adapter/).

HTTP and WebSocket handshakes enforce exact allowed origins. Statistics preflight permits Authorization; no cookies or credentialed CORS are used. Requests without Origin are allowed for probes/non-browser clients. CORS is not authentication: guest identities and room IDs do not create private accounts/rooms. Socket payloads are bounded at 16 KiB and per-socket queues are bounded. Existing per-guest event limits remain; comprehensive abuse protection is outside V1.

SIGTERM/SIGINT marks readiness unavailable and refuses new work, closes socket **transports** to trigger automatic retry, drains accepted mutations/disconnect cleanup/background accounting, then closes Redis and PostgreSQL. The process has a 25-second deadline inside the host's 30-second grace. Unfinished stored accounting and leases support recovery. A namespace disconnect would suppress automatic client retries and is intentionally not used for deployment drain.

Clients retry with backoff and reconcile room snapshots. Mutations are not indiscriminately replayed; existing task creation request IDs deduplicate retries. Voice disables tracks while offline and rebuilds peers after rejoin. One minute offline stops the microphone; refresh always requires a new explicit join.

## Health and logs

| Endpoint / event | Meaning |
| --- | --- |
| `/api/health` | HTTP process alive, even during datastore failure |
| `/api/ready` | Bounded PostgreSQL query plus PINGs on Redis command/publisher/subscriber; 503 on failure or drain |
| `database.migrations_complete` | Applied count; zero means current |
| `server.listening` | Dependencies/migrations verified before opening listener |
| `redis.unavailable` / `redis.ready` | Required connection loss/recovery |
| `runtime.checkpoint_failed` | Accounting retained for retry; investigate stores |
| `server.shutdown_started` / `server.shutdown_complete` | Drain lifecycle |
| `server.shutdown_timeout` | Deadline forced exit |
| `http.request` | Generated request ID, method, route pattern, status, duration |

Logs are newline-delimited JSON on stdout/stderr in production; `LOG_LEVEL=info` is the initial setting. Successful health probes are omitted from request logs. Credentials, headers, bodies, query strings, media payloads and raw Error objects are excluded. Monitor readiness, error rates, forced shutdowns, database connections and Redis memory. A PING proves connectivity, not backup durability or available write capacity.

## HTTPS microphone and TURN

The local smoke test serves the built app on a non-loopback-named HTTPS test origin and connects to production Node processes over WSS. It uses a **generated synthetic microphone tone**: no physical microphone is captured or recorded. Checks include secure-context APIs, no capture before Join Voice, decoded audio energy both ways, reconnect without reacquiring media, and refresh without capture. Only local test mode accepts its temporary certificate; remote mode requires valid certificates. [Secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).

**TURN is not provisioned.** Public STUN cannot guarantee audio through symmetric/restrictive NATs or networks blocking peer traffic. HTTPS/WSS does not solve media traversal. The six-guest mesh and local audio pass do not establish physical-device quality or cross-network reachability. Wider production voice reliability needs a TURN relay and server-issued expiring credentials. `VITE_ICE_SERVERS` is public build-time configuration, unsuitable for permanent secrets or rotating credentials. That work remains outside this milestone.

## Hosted acceptance — pending deployment

- Valid HTTPS certificates and HTTP-to-HTTPS redirects on both origins. Direct/refresh navigation to `/r/<room>`, `/room/<room>` and `/join` succeeds.
- Private datastores have intended persistence/backups. Release logs show successful migrations/dependencies; a repeat migration changes nothing.
- `/api/ready` is 200; unlisted HTTP/WSS origins fail; statistics preflight succeeds.
- Independent profiles see matching presence/tasks/timer/chat; Developer Tools shows WSS without mixed content.
- Run synthetic verification below (creates a unique room, two guests, a task and chat message; use staging first):

```powershell
$env:FRONTEND_URL = 'https://YOUR-FRONTEND'
$env:BACKEND_URL = 'https://YOUR-BACKEND'
npm.cmd run deploy:verify
```

- On real devices with headphones, explicitly permit microphones; verify bidirectional voice, mute/unmute and leave cleanup. Repeat across networks and record restrictive-network failures under the TURN limitation.
- Redeploy/restart the backend with guests connected. Confirm shutdown completion, automatic recovery, no duplicate guests, preserved timer deadline/tasks and restored voice without a second microphone prompt. Remote smoke does not restart hosting or inspect migration tables.
- In staging, interrupt Redis/PostgreSQL and verify readiness 503, rejected unsafe operations and recovery after restoration. Do not simulate outages against active production users without a maintenance plan.
- Record release commit, URLs, migration logs, smoke report and physical-device/network results. `.vite/production-report.json` records each local/remote run; local success is not hosted acceptance.
