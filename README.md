# GTM Workbench

## Railway Deployment

The workbench runs as three Railway services from the same repo. Set up each service once in the Railway dashboard — every subsequent push to `staging` (or `main`) deploys all three automatically.

---

### Part 1: Hub (API + Web)

The hub is the main backend service. It serves the Hono API and static web assets, and runs database migrations on each deploy.

**In the Railway dashboard:**

1. Create a new Railway project. Add a service from this repo.
2. Set the config file path to `railway.toml` (repo root).
3. Add a **Postgres** plugin — Railway injects `DATABASE_URL` automatically.
4. Add a **Volume** and mount it at `/data`. Set `HUB_DATA_DIR=/data` in the service env vars. This stores per-agent git repos and signing state — loss of this volume requires re-provisioning all sidecars.
5. Enable public networking: **Settings → Networking → Public Networking → Generate Domain**. Note the generated URL (e.g. `https://your-hub.up.railway.app`).
6. Set environment variables:
   - `HUB_DATA_DIR` — `/data`
   - `BETTER_AUTH_SECRET` — `openssl rand -hex 32`
   - `BETTER_AUTH_BASE_URL` — the hub's public URL from step 5
   - `SUPPORTED_CORS_ORIGINS` — the web app's public URL (set after deploying the web app)
   - `OPENAI_COMPATIBLE_API_KEY`
   - `OPENAI_COMPATIBLE_MODEL`
   - `INTERCHANGE_HUB_TOKEN` — shared secret used by the sidecar to register (generate a random value)
7. Deploy. `railway.toml` runs database migrations automatically before each deploy.

---

### Part 2: Sidecar

The sidecar connects to the hub via WebSocket and manages the lifecycle of running agents. It requires a persistent volume — loss of this data breaks the sidecar–hub trust relationship.

**In the Railway dashboard:**

1. Add a second service to the same Railway project from this repo.
2. Set the config file path to `apps/sidecar/railway.toml`.
3. Add a **Volume** and mount it at `/data`.
4. Set environment variables:
   - `HUB_WS_URL` — WebSocket URL of the hub (e.g. `wss://your-hub.up.railway.app/api/sidecars/ws`)
   - `SIDECAR_ID` — a stable slug for this instance (e.g. `gtm-staging`)
   - `SIDECAR_TOKEN` — must match `INTERCHANGE_HUB_TOKEN` set on the hub service
   - `SIDECAR_DATA_DIR` — `/data`
5. Deploy.

---

### Part 3: Web App

The web app is a static Vite build. Deploy it to **Vercel** (recommended) or as a third Railway service.

#### Option A: Vercel (recommended)

1. Import the repo in Vercel. Set the root directory to `apps/web`.
2. Set the build command to `bun run build` and output directory to `dist`.
3. Set environment variables:
   - `VITE_API_BASE_URL` — the hub's public URL
4. Deploy. Vercel rebuilds on each push automatically.
5. Add the Vercel deployment URL to `SUPPORTED_CORS_ORIGINS` on the hub service.

#### Option B: Railway

1. Add a third service to the same Railway project from this repo.
2. Enable public networking and note the URL.
3. Set environment variables:
   - `VITE_API_BASE_URL` — the hub's public URL
4. Set build command: `bun install && bun run --filter @gtm/web build`
5. Set start command: `bunx serve apps/web/dist`
6. Add the service's public URL to `SUPPORTED_CORS_ORIGINS` on the hub service.
