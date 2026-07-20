# Workbench

An agentic workbench built around a shared knowledge base. Agents don't wait
to be asked — they work the evidence, run automations, and bring you finished
work (or decisions) to approve.

## Testing & coverage

Run the suite across every workspace:

```bash
bun run test            # all @workbench/* workspaces
bun run test:coverage   # same, but each workspace emits coverage/lcov.info
bun run coverage:report # merge the lcov reports into one monorepo number
bun run coverage        # test:coverage + coverage:report in one shot
```

**80% merged line coverage is the enforced hard floor** — this matches
`AGENTS.md` and is the value `coverage:report` actually enforces
(`COVERAGE_THRESHOLD=80`). `coverage:report` merges every workspace's
`coverage/lcov.info` and exits non-zero until the aggregate clears 80%. 80% is
the floor, not the goal: every change should leave coverage equal or higher.
98.5% remains the aspirational ramp target tracked in the "Test coverage to
98.5%" Linear project, but it is not the CI gate.

Notes on how the number is computed (`scripts/coverage-merge.ts`):

- **Line coverage only.** Bun instruments lines and functions but emits no
  per-function records in lcov, so functions cannot be unioned across runs.
  Line coverage is the reported metric. (Branch coverage is not available in
  Bun at all.)
- **Union by file.** A workspace's lcov includes every file it imports —
  `interchange/` and other `@workbench/*` packages included. The merge resolves
  each path, drops `interchange/`, `node_modules/`, and test files, and unions
  line hits per file so each instrumented line counts once and is "covered" if
  any test run hit it.
- **Untested files are invisible until a test imports them.** Bun only
  instruments files loaded during a run, so a source file no test touches is
  absent from the denominator rather than counted as 0%. As the ramp tickets
  add tests, those files enter the denominator and the aggregate moves.

## Railway Deployment

The workbench runs as **three standalone Railway services** from the same repo — `hub`, `web`, and `sidecar`. Each has its own `Dockerfile` and `railway.toml` co-located in its app directory. Set up each service once in the Railway dashboard; every subsequent push to `staging` (or `main`) deploys the affected services automatically (each service's `watchPatterns` decides which ones rebuild).

### Monorepo model — read this first

This is a **shared monorepo** (one Bun workspace). Every service builds with the **repo root as its Docker build context** because they all depend on the shared lockfile, `packages/*`, and the vendored `interchange/packages/*` workspaces. Two consequences for every service:

- **Root Directory must stay `/`.** Do not set a per-service root directory — it would scope the Docker build to one app folder and break the workspace install.
- **The Railway config file does NOT follow the Root Directory** (per Railway's monorepo docs). You must set each service's **Config-as-Code path** (Settings → Config-as-Code) to its absolute repo-root path, listed per service below.

---

### Part 1: Hub (API)

The hub is the API-only backend. It serves the Hono API and runs database migrations on each deploy. It does **not** serve the web app — that is a separate static service.

**In the Railway dashboard:**

1. Create a new Railway project. Add a service from this repo.
2. Set **Root Directory** to `/` and the **Config-as-Code path** to `/apps/hub/railway.toml`.
3. Add a **Postgres** plugin — Railway injects `DATABASE_URL` automatically.
4. Add a **Volume** and mount it at `/data`. Set `HUB_DATA_DIR=/data`. This stores per-agent git repos and signing state — loss of this volume requires re-provisioning all sidecars.
5. Enable public networking: **Settings → Networking → Public Networking → Generate Domain**. Note the URL (e.g. `https://your-hub.up.railway.app`).
6. Set environment variables:
   - `HUB_DATA_DIR` — `/data`
   - `BETTER_AUTH_SECRET` — `openssl rand -hex 32`
   - `BETTER_AUTH_BASE_URL` — the hub's public URL from step 5
   - `SUPPORTED_CORS_ORIGINS` — the web app's public URL (set after deploying the web service)
   - `OPENAI_COMPATIBLE_API_KEY`
   - `OPENAI_COMPATIBLE_MODEL`
   - `INTERCHANGE_HUB_TOKEN` — shared secret used by the sidecar to register (generate a random value)
7. Deploy. The pre-deploy command runs database migrations automatically before each deploy.

---

### Part 2: Web (static)

The web app is a static Vite build. `apps/web/Dockerfile` builds the SPA with full repo context (needed for `@workbench/shared`) and serves the output with Caddy — no Node/Bun process runs at runtime. SPA routes fall back to `index.html`.

> The build needs the whole workspace, so Railway's zero-config static auto-detect cannot be used; the bundled Dockerfile is required. Caddy is the same static server Railway's own static provider uses under the hood.

**In the Railway dashboard:**

1. Add a service to the same project from this repo.
2. Set **Root Directory** to `/` and the **Config-as-Code path** to `/apps/web/railway.toml`.
3. Enable public networking and note the URL.
4. Set the **build-time** environment variable:
   - `VITE_API_BASE_URL` — the hub's public URL (baked into the bundle at build time, so a change requires a redeploy)
5. Deploy.
6. Add this service's public URL to `SUPPORTED_CORS_ORIGINS` on the **hub** service.

> Alternative: the static `dist` can also be hosted on any static host (e.g. Vercel with root `apps/web`, build `bun run build`, output `dist`). The Railway service above is the supported default.

---

### Part 3: Sidecar

The sidecar connects to the hub via WebSocket and manages the lifecycle of running agents. It requires a persistent volume — loss of this data breaks the sidecar–hub trust relationship.

**In the Railway dashboard:**

1. Add a service to the same project from this repo.
2. Set **Root Directory** to `/` and the **Config-as-Code path** to `/apps/sidecar/railway.toml`.
3. Add a **Volume** and mount it at `/data`.
4. Set environment variables:
   - `HUB_WS_URL` — WebSocket URL of the hub (e.g. `wss://your-hub.up.railway.app/api/sidecars/ws`)
   - `SIDECAR_ID` — a stable slug for this instance (e.g. `gtm-staging`)
   - `SIDECAR_TOKEN` — must match `INTERCHANGE_HUB_TOKEN` set on the hub service
   - `SIDECAR_DATA_DIR` — `/data`
5. Deploy.
