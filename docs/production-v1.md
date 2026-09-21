# Production deployment and hardening V1

Constellate uses one Vercel project for the React/Vite frontend and same-origin reverse proxy, plus one Render Blueprint for the Node/Express/Socket.IO backend, PostgreSQL, and Redis.

## Production topology

```text
Browser
  ├─ HTTPS static app ───────────────> Vercel
  ├─ HTTPS API + Socket.IO ─────────> Vercel same-origin proxy
  └─ peer-to-peer WebRTC audio ─────> other browsers

Vercel same-origin proxy
  └─ forwarded API + Socket.IO ─────> Render Node service

Render Node service
  ├─ durable rooms/tasks/history ───> Render PostgreSQL
  └─ live state + Socket.IO Pub/Sub -> Render Key Value (Redis)
```

Audio does not pass through Render, Socket.IO, PostgreSQL, or Redis. Socket.IO only carries signaling and application events.

## Vercel frontend

Create exactly one Vercel project from this repository. Use these project settings:

| Setting | Value |
| --- | --- |
| Root Directory | repository root (`.` / leave blank) |
| Framework Preset | Vite |
| Install Command | `npm ci --include=dev` |
| Build Command | `npm run build:vercel` |
| Output Directory | `client/dist` |
| Node version | 24.x, pinned by `.node-version` and root `package.json` |

Do not set the Root Directory to `client`. The frontend imports TypeScript contracts from `shared/`, and Vercel does not allow a project to access files above its configured root. Root `vercel.json` records the commands, output path, security headers, the external `/api` and `/socket.io` rewrites, and the SPA rewrite needed for `/r/*`, `/room/*`, and `/join` deep links. The Vercel build fails before compiling unless the checked production backend and same-origin routing switch are exact.

Manually enter this Vercel environment variable for Production:

| Variable | Required | Value |
| --- | --- | --- |
| `VITE_SERVER_URL` | Yes | Exact Render backend HTTPS origin, with no trailing slash, path, query, or credentials |
| `VITE_SAME_ORIGIN_BACKEND` | Yes | `true`; checked into `.env.production` so browsers call Vercel `/api` and `/socket.io` |
| `VITE_ICE_SERVERS` | No | Public JSON ICE server array; leave unset for the current public STUN default |

`VITE_SERVER_URL` is intentionally public build configuration and pins the Render destination checked by the deployment guard. With `VITE_SAME_ORIGIN_BACKEND=true`, the browser itself uses the Vercel origin for HTTP statistics and Socket.IO. Changing any `VITE_*` variable requires a new frontend deployment. Do not add `DATABASE_URL`, `REDIS_URL`, or private credentials to Vercel.

## Render backend and managed stores

Import root `render.yaml` as a Render Blueprint. It contains only:

- `constellate-api`: Node web service
- `constellate-postgres`: managed PostgreSQL
- `constellate-redis`: managed Key Value/Redis

There is no Render frontend/static service. The stores have no public IP allowlist. Redis uses persistence and `noeviction`, because evicting live state or pending study accounting is unsafe. The blueprint uses Singapore and a paid always-on baseline; review current pricing and choose another region/plan before creation if needed.

The only value the Blueprint prompts you to enter manually is:

| Variable | Required | Value |
| --- | --- | --- |
| `CLIENT_ORIGINS` | Yes | Exact Vercel production origin, e.g. `https://your-project.vercel.app`; comma-separate additional exact HTTPS origins if needed |

Do not use a wildcard or trailing slash. Production rejects HTTP, localhost, paths, credentials, and wildcard origins. Express CORS and Socket.IO handshakes use this same allowlist. Preview deployments have unique origins; add a specific preview origin deliberately or use only the stable Production domain.

The Blueprint supplies these backend values; do not enter them manually when using it:

| Variable | Source |
| --- | --- |
| `DATABASE_URL` | Render PostgreSQL private `connectionString` via `fromDatabase` |
| `REDIS_URL` | Render Key Value private `connectionString` via `fromService` |
| `REDIS_KEY_PREFIX` | Blueprint value `constellate:production` |
| `NODE_ENV`, `NODE_VERSION`, `HOST` | Blueprint production/runtime values |
| `TRUST_PROXY_HOPS`, `LOG_LEVEL`, `HEALTH_TIMEOUT_MS`, `SHUTDOWN_TIMEOUT_MS` | Blueprint hardening values |
| `PORT` | Render platform injects it at runtime; do not set it |

If you create the web service and stores manually instead of importing the Blueprint, enter all of the above values yourself, using the stores' private connection strings. Never copy `server/.env` to Render. Production ignores local `.env` files.

## Database migrations

Render runs the exact migration command as a pre-deploy command after compiling the server:

```sh
npm run db:migrate:production
```

The command uses `DATABASE_URL`, applies only unapplied SQL migrations, and records checksums in `schema_migrations`. It runs in a transaction and uses a PostgreSQL advisory lock, so concurrent runners serialize. It never drops or recreates production tables. Editing an applied migration is rejected; add a new migration instead.

If you need to run it manually after the database exists, use the Render backend Shell with the same command. Startup independently verifies the schema and refuses to listen if a migration is missing or changed.

## Health, HTTPS, and Socket.IO

Render uses:

```text
GET /api/health
```

A healthy response is HTTP 200:

```json
{"status":"ok","server":"ok","database":"ok","redis":"ok"}
```

Dependency failure or shutdown drain returns HTTP 503 with component status values. No hostnames, database names, usernames, passwords, URLs, or credentials appear in the response. `/api/ready` is a compatible alias.

Render terminates HTTPS and forwards to the Node HTTP listener. The production client calls Vercel `/api` and `/socket.io`; Vercel forwards those same-origin requests to Render. Socket.IO starts with HTTP polling and attempts to upgrade to WebSocket when available. The polling connection remains usable when the upgrade or direct Render hostname is blocked. The Blueprint uses one backend instance; configure session affinity before scaling to multiple instances because polling requests for one session must reach the same instance. Local development remains unchanged: the empty `VITE_SERVER_URL` uses the page origin, and Vite proxies `/api` and `/socket.io` to the local backend.

The Redis adapter uses the three clients created from `REDIS_URL` for commands, publishing, and subscriptions. It coordinates live room state and cross-node events. Reconnect performs a fresh room join and reloads authoritative snapshots; the Pub/Sub adapter does not replay missed packets.

On SIGTERM/SIGINT the backend marks health unavailable, refuses new work, closes transports so clients retry, drains accepted mutations and accounting, then closes Redis and PostgreSQL. The 25-second application deadline fits inside Render's 30-second shutdown grace.

## Exact deployment order

1. Review the diff and run all checks listed below. Do not use production database credentials locally.
2. Commit and push the deployment-ready branch to GitHub when you are ready.
3. Create/import the Vercel project from the repository, with Root Directory left at the repository root. Note its stable Production origin. The first deployment can wait until `VITE_SERVER_URL` is known.
4. Import `render.yaml` into Render. Confirm it proposes one Node web service, one PostgreSQL database, and one Key Value/Redis service—no static frontend.
5. Enter `CLIENT_ORIGINS` using the exact Vercel Production origin. Create the Blueprint resources.
6. Render builds the server and automatically runs `npm run db:migrate:production` before starting it. Confirm the migration log and successful backend deployment.
7. Open `https://<render-backend>/api/health` and confirm HTTP 200 with all four fields `ok`.
8. In Vercel, set Production `VITE_SERVER_URL` to the exact Render backend HTTPS origin. Keep `VITE_SAME_ORIGIN_BACKEND=true` and leave `VITE_ICE_SERVERS` unset unless configuring a reviewed ICE list.
9. Deploy the single Vercel frontend. Open a deep room link directly and confirm it loads.
10. Confirm the browser's actual production origin exactly matches Render `CLIENT_ORIGINS`. If Vercel assigned a different alias/custom domain, update `CLIENT_ORIGINS` and redeploy only the Render backend.
11. Run the hosted verification and the manual production checklist below.

This order resolves the origin dependency without deploying a second frontend. If you already know the final Vercel custom domain, you can enter it in Render before the Vercel deployment.

## Verification commands

Run before committing:

```powershell
npm.cmd test
npm.cmd run test:db
npm.cmd run test:redis
npm.cmd run build
npm.cmd run test:production
```

The database/Redis/production suites require the project-local test services and a separate `TEST_DATABASE_URL`. The production suite builds the app, runs compiled migrations, serves separate HTTPS frontend/API origins, connects browsers across two Node processes, verifies CORS/WSS, checks synthetic WebRTC audio, performs graceful failover, and confirms the exact timer deadline and presence survive reconnect.

After deployment, set only public deployment origins locally and run:

```powershell
$env:FRONTEND_URL = 'https://YOUR-VERCEL-PRODUCTION-ORIGIN'
$env:BACKEND_URL = 'https://YOUR-RENDER-BACKEND-ORIGIN'
npm.cmd run deploy:verify
```

The remote check creates a unique room, two guests, a task, and a chat message. Use staging first if that data is undesirable in production. It verifies real certificates but does not restart Render or inspect production migration tables.

## Manual production checklist

- Direct navigation and refresh work for `/`, `/join`, `/r/<room>`, and `/room/<room>` on Vercel.
- Browser requests contain no `localhost`, `127.0.0.1`, `http://`, mixed content, or direct calls to the Render hostname; API requests use Vercel `/api`.
- Socket.IO connects through Vercel `/socket.io` with `transport=polling` and attempts a WebSocket upgrade when available; a blocked upgrade leaves polling connected.
- An unlisted Origin fails both HTTP CORS and the Socket.IO handshake. The Vercel production origin succeeds.
- Two independent browser profiles share presence, tasks, chat, reactions, and one timer deadline.
- A Render redeploy causes automatic reconnect without duplicate guests or reset timers/tasks. Logs contain `server.shutdown_complete`.
- `/api/health` becomes 503 during dependency loss and returns to 200 after recovery. Test deliberate outages only in staging.
- Joining voice explicitly prompts for the microphone; audio works in both directions, mute/unmute works, and leaving stops tracks.
- Test voice on two physical devices and on different networks. Record networks that need TURN.
- Render logs show structured JSON and no connection strings, authorization headers, message bodies, SDP, or ICE candidates.

## Remaining limitations

TURN is not provisioned. Public STUN cannot guarantee WebRTC audio through symmetric/restrictive NATs, corporate networks, or some mobile carriers. HTTPS/WSS enables microphone permission and signaling but does not solve media traversal. A future TURN service must issue short-lived credentials; permanent TURN secrets do not belong in `VITE_ICE_SERVERS`.

Rooms use anonymous guest identities and guessable room IDs, not authenticated private membership. CORS protects browser origins but is not authorization. Production capacity is not load-tested, and the current Blueprint declares one backend instance even though Redis supports cross-node coordination. Physical microphone quality, Safari/Firefox/mobile behavior, custom-domain DNS, backups/restores, and hosted outage recovery remain manual operational checks.
