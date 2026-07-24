# Deployment

This guide covers deploying GTM Workbench to production from scratch. The stack is three services (hub, web, sidecar) plus a PostgreSQL database. The reference deployment platform is **Railway** — the Dockerfiles and `railway.toml` configs are included. Any provider that can run Docker containers with persistent volumes and PostgreSQL works.

---

## Services

| Service        | What it does                              | Needs persistent volume? |
| -------------- | ----------------------------------------- | ------------------------ |
| **Hub**        | Hono API, DB migrations, agent launch     | Yes (`HUB_DATA_DIR`)     |
| **Web**        | Static SPA served by Caddy                | No                       |
| **Sidecar**    | Agent lifecycle, WebSocket hub connection | Yes (`SIDECAR_DATA_DIR`) |
| **PostgreSQL** | Persistence                               | Yes                      |

Hub and sidecar must redeploy together whenever `packages/**` or agent definitions change. If only one is updated, agents will fail to reconnect with "No sidecar connected."

---

## Step 1 — Provision infrastructure

### PostgreSQL

You need a PostgreSQL 15+ instance reachable from the hub. Note the connection string — you will use it as `DATABASE_URL`.

On Railway: add a PostgreSQL plugin to your project. The connection string is available in the plugin's Variables tab.

### Persistent volumes

Create two persistent volumes:

- One for the sidecar (mount at `/data`)
- One for the hub (mount at `/data`)

On Railway: add a volume to each service via the service's Volumes tab.

### Google OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
2. Create an OAuth 2.0 Client ID (Web application)
3. Add your production web URL to "Authorized JavaScript origins"
4. Add `https://<web domain>/api/auth/callback/google` to "Authorized redirect URIs" (the **web** URL that proxies `/api` to the hub — not the bare hub hostname unless web and hub share one origin)
5. Copy the Client ID and Client Secret

---

## Step 2 — Configure environment variables

### Hub

Set all of these on the hub service:

```
DATABASE_URL=<postgres connection string>
BETTER_AUTH_SECRET=<output of: openssl rand -hex 32>
BETTER_AUTH_BASE_URL=https://<web domain>
GOOGLE_CLIENT_ID=<google oauth client id>
GOOGLE_CLIENT_SECRET=<google oauth client secret>
GOOGLE_ALLOWED_DOMAINS=<comma-separated domains, e.g. yourcompany.com>
SUPPORTED_CORS_ORIGINS=https://<web domain>
HUB_DATA_DIR=/data
HUB_SIGNING_KEYS=1:<output of: openssl rand -hex 32>
GLOBAL_TENANT_SLUG=<url-safe slug for your org, e.g. acme>
GLOBAL_TENANT_NAME=<display name, e.g. Acme Corp>
GLOBAL_TENANT_DOMAIN=<email domain users will sign in with, e.g. acme.com>
SIDECAR_TOKEN=<output of: openssl rand -hex 32>  # must match sidecar's SIDECAR_TOKEN
PORT=4000
```

Optional monitoring:

```
SENTRY_DSN=<dsn from sentry>
SENTRY_ENVIRONMENT=production
```

### Sidecar

```
HUB_WS_URL=wss://<hub domain>/api/sidecars/ws
SIDECAR_ID=<stable slug, e.g. gtm-prod>
SIDECAR_TOKEN=<same value as hub's SIDECAR_TOKEN>
SIDECAR_DATA_DIR=/data
```

### Web

```
HUB_URL=https://<hub domain>
```

Build-time (Docker `ARG` / Railway build variable) — leave **unset** or empty so the SPA calls same-origin `/api` (proxied by Caddy to `HUB_URL`). Do **not** set `VITE_API_BASE_URL` to the hub domain in production; that forces cross-site auth cookies and breaks Google sign-in on mobile Safari.

Optional branding:

```
VITE_APP_ENV=production
```

> **Live updates on Safari/Brave when web and hub are cross-site.** Live chat
> uses an SSE `EventSource`. If the web and hub are served from different
> registrable domains (e.g. `*.vercel.app` + `*.up.railway.app`), Safari (ITP)
> and Brave (shields) treat the credentialed stream as third-party and may drop
> it, so replies only appear after a reload — `fetch` is unaffected, so the rest
> of the app works. Chrome is fine. To fix it, make web and hub **same-site**:
> serve them as subdomains of one root (e.g. `app.example.com` +
> `api.example.com`) with the auth cookie scoped to the shared parent. This is
> only a concern in cross-site deployments; same-site setups need no change.

### Vercel (web) + Railway (hub)

This is the supported split layout. The browser must call **same-origin** `/api` on your Vercel URL; Vercel rewrites proxy those requests to Railway. Do **not** point the built SPA at the hub with `VITE_API_BASE_URL` — that breaks Google sign-in on mobile Safari (`state_mismatch`).

**Vercel** (Project → Settings → Environment Variables):

| Variable            | Value                                                   |
| ------------------- | ------------------------------------------------------- |
| `HUB_UPSTREAM_URL`  | `https://<your-hub>.up.railway.app` (no trailing slash) |
| `VITE_API_BASE_URL` | **Delete** or leave empty for Production/Preview        |

The Vercel **install** step generates root `middleware.ts`, which proxies `/api` and `/sidecar` to `HUB_UPSTREAM_URL` at runtime (rewrites written to `vercel.json` during install are not sufficient on their own).

Set `HUB_UPSTREAM_URL` for **Production and Preview** in Vercel. Without it, `/api/auth/callback/google` returns **404** on the Vercel host.

**405 on `POST /api/auth/sign-in/social`:** Vercel is serving the SPA for `/api` (static hosting rejects POST). Fix is in **root `vercel.json`** (`/api/:path*` → Railway hub). Redeploy after that file is on your branch.

Vercel often has **no separate “Rewrites” screen** in Settings (rules come from `vercel.json`). Some teams see **Settings → Redirects** (rewrites may appear there on older UI). You do **not** need the dashboard if `vercel.json` is correct.

**Project → Settings → General → Root Directory** must be **empty** (repo root). If it is `apps/web`, Vercel ignores root `vercel.json` — either clear Root Directory or copy the same `rewrites` into `apps/web/vercel.json`.

**Railway hub**:

| Variable                 | Value                                     |
| ------------------------ | ----------------------------------------- |
| `BETTER_AUTH_BASE_URL`   | `https://<your-vercel-production-domain>` |
| `SUPPORTED_CORS_ORIGINS` | same as `BETTER_AUTH_BASE_URL`            |

**Google Cloud Console** (OAuth client):

- JavaScript origins: `https://<your-vercel-production-domain>`
- Redirect URI: `https://<your-vercel-production-domain>/api/auth/callback/google`

Redeploy the hub after env changes, then trigger a **new Vercel production build** (so rewrites are applied and the bundle has no embedded hub URL).

Forks: replace the Railway host in root `vercel.json` `/api` + `/sidecar` rewrites, or rely on `HUB_UPSTREAM_URL` during install (overwrites `vercel.json` rewrites when set).

---

## Step 3 — Deploy services

### Railway (reference deployment)

Each service is a separate Railway service in the same project, all using the **repo root** as the Docker build context. This is a shared monorepo (one Bun workspace): every service depends on the shared lockfile, `packages/*`, and the vendored `interchange/packages/*`, so the build context cannot be scoped to a single app folder.

Two consequences follow from that:

- **Root Directory must stay `/`.** A per-service root directory would scope the Docker build to one app folder and break the workspace install.
- **The `railway.toml` does not follow the Root Directory** (per Railway's monorepo docs) — set each service's Config-as-Code path to its absolute repo-root path (below).

Once configured, every push to `staging` (or `main`) deploys the affected services automatically — each service's `watchPatterns` decides which ones rebuild.

1. Create a new Railway project
2. Add a new service → "GitHub Repo" → select your fork
3. In service settings:
   - **Root Directory**: `/` (repo root)
   - **Config as Code**: set the path to the service's `railway.toml` (absolute from repo root)
     - Hub: `apps/hub/railway.toml`
     - Web: `apps/web/railway.toml`
     - Sidecar: `apps/sidecar/railway.toml`
4. Set environment variables from Step 2
5. Attach persistent volumes (hub → `/data`, sidecar → `/data`)
6. Deploy

The hub's `railway.toml` runs `bun run scripts/db-setup.ts` as a pre-deploy command, which applies pending migrations before the hub starts. Migrations are **not** manually gated — they run automatically at the start of every deploy, in filename order. This makes the ordering below load-bearing: get it wrong and the data loss happens automatically, before anyone can intervene.

### Migration ordering / one-time data migrations

- **`artifact.status` drop is deferred, not shipped.** An earlier migration (`0079_drop_artifact_status.sql`) would have unconditionally dropped the `artifact.status` column. It has been pulled out of the release: its data-preservation script, `apps/hub/bin/migrate-skill-drafts-to-assets.ts`, is currently a **no-op** — the Drizzle `artifact` model in `apps/hub/src/db/schema.ts` no longer maps `status`, so the script's `row.status === "draft"` filter is always false and it migrates zero rows regardless of when it runs. Running it produces "0 pending" unconditionally, not as confirmation that migration is safe. Until a fixed version of that script exists (reading `status` via raw SQL, not the ORM model), the column drop stays out of any release. The `status` column itself remains in place in the meantime — it's harmless, the ORM already ignores it, and no shipped code depends on it being gone (only a stale comment in `apps/hub/src/services/search.ts`). When this is eventually revisited, it must be preceded by a fixed data migration that reads `status` via raw SQL, verified against a direct prod `SELECT count(*) FROM artifact WHERE kind='skill-draft' AND status='draft'`.
- **`apps/hub/migrations/0076_granola_call_to_work_unit.sql` → `0077_drop_granola_call_job.sql`** is a paired cutover: 0076 copies open (`pending`/`processing`/`dead`) `granola_call_job` rows into `work_unit` and marks the originals `done`; 0077 then drops the `granola_call_job` table outright. Because both run automatically in the same deploy pass (filename order), verify — before that deploy ships — that 0076's copy logic covers every row shape actually present on the target environment; there is no re-run once 0077 has dropped the table.

### Other providers

Build each service using its Dockerfile with the repo root as the build context:

```bash
docker build -f apps/hub/Dockerfile -t gtm-hub .
docker build -f apps/web/Dockerfile -t gtm-web .
docker build -f apps/sidecar/Dockerfile -t gtm-sidecar .
```

The hub needs the `DATABASE_URL` at build time only if your provider requires migrations at build time. Otherwise migrations run on first boot via the pre-deploy command.

Start order: PostgreSQL → hub → sidecar → web.

---

## Step 4 — First-boot provisioning

On first boot the hub automatically:

- Seeds the global org tenant from `GLOBAL_TENANT_SLUG`/`GLOBAL_TENANT_NAME`/`GLOBAL_TENANT_DOMAIN`
- Seeds agent definitions (Myra, Oat, Freddy, Walter, Loop) via `seedAgentTemplates`

Both operations are idempotent — re-deploys are no-ops.

### Create the superadmin user

Run the seed script against your running hub to create the initial user and grant it owner access. This user is what you will use to log into admin-ui to manage credentials, providers, and agent definitions.

```bash
HUB_URL=https://<hub domain> \
SUPERADMIN_EMAIL=<your email> \
SUPERADMIN_NAME=<your name> \
SUPERADMIN_PASS=<secure password> \
GLOBAL_TENANT_SLUG=<your slug> \
bun run apps/hub/bin/seed.ts
```

Or from inside the hub container if your provider supports exec:

```bash
bun --env-file=.env run apps/hub/bin/seed.ts
```

---

## Step 5 — Add credentials

Agents cannot launch until credentials are in place. The SEO enrichment workflow also
requires a separate Google Gemini credential (multimodal image+text inference). Add
credentials via admin-ui or via script.

### Via admin-ui

1. Navigate to `https://<admin-ui domain>` and sign in with the superadmin account
2. Go to Tenants → select your org tenant → Credentials
3. Click "Add credential":
   - Provider: `openai-compatible` or `bifrost` (or the provider you are using)
   - Name: `Myra LLM` (this name must match the agent definition's credential requirement)
   - API key: your LLM API key
   - Model: e.g. `gpt-4o`
   - Base URL: e.g. `https://api.openai.com/v1`
4. Credentials are stored tenant-owned and resolve to all agents automatically

**Bifrost virtual keys**

Bifrost virtual keys (`vk-...`) are supported. In the owner UI (Admin → Catalog) under "Provider credentials", choose Bifrost, paste the `vk-...` value as the API key, and supply your Bifrost base URL (e.g. `https://your-bifrost:8080/v1`). The owner form sends the key as `Authorization: Bearer` exactly as the openai-compatible adapter expects. No special headers are sent.

### Via script (single or primary LLM credential)

`add-llm-credential.ts` upserts the primary agent LLM credential (Anthropic, OpenAI,
Bifrost, or openai-compatible depending on env vars / LLM_PROVIDER_NAME). When `GOOGLE_GEMINI_API_KEY` or
`GEMINI_API_KEY` is also set, it upserts the SEO enrichment credential in the same
run. Prefer `seed-credentials.ts` for Google (see below) — it reconciles stale
provider metadata that `add-llm-credential` does not patch.

On OAuth-only deployments where email/password sign-in is disabled, pass
`SESSION_TOKEN` (the `__Secure-better-auth.session_token` cookie from browser
DevTools) instead of `SUPERADMIN_EMAIL` / `SUPERADMIN_PASS`.

```bash
HUB_URL=https://<hub domain> \
GLOBAL_TENANT_SLUG=<your slug> \
SESSION_TOKEN=<session cookie> \
OPENAI_COMPATIBLE_API_KEY=<your key> \
OPENAI_COMPATIBLE_MODEL=gpt-4o \
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1 \
LLM_CREDENTIAL_NAME="Myra LLM" \
GOOGLE_GEMINI_API_KEY=<gemini api key> \
bun run apps/hub/bin/add-llm-credential.ts
```

### Via script (all credentials at once) — preferred

`seed-credentials.ts` is the canonical batch seed. It creates or updates each
provider (reconciling `metadata.baseURL` on existing tenant-owned rows) and upserts
the matching tenant credential. Entries without a key in the environment are
skipped silently. Safe to re-run after adding keys or upgrading workflow credential
requirements.

Set any combination of the following and run:

```bash
HUB_URL=https://<hub domain> \
GLOBAL_TENANT_SLUG=<your slug> \
SESSION_TOKEN=<session cookie> \
OPENAI_COMPATIBLE_API_KEY=sk-... \
OPENAI_COMPATIBLE_MODEL=gpt-4o \
OPENAI_COMPATIBLE_BASE_URL=https://api.openai.com/v1 \
GOOGLE_GEMINI_API_KEY=<gemini api key> \
GRANOLA_API_KEY=... \
EXA_API_KEY=... \
FIRECRAWL_API_KEY=... \
BLUESKY_HANDLE=yourhandle.bsky.social \
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
bun run apps/hub/bin/seed-credentials.ts
```

`GEMINI_API_KEY` is accepted as an alias for `GOOGLE_GEMINI_API_KEY`. Optional
overrides: `GOOGLE_AI_CREDENTIAL_NAME` (default `google-ai`),
`GOOGLE_AI_MODEL` (default `gemini-3.1-flash-lite`, stored in credential metadata
only).

### Google Gemini credential

Seeding a Gemini key creates a **tenant-owned** credential named **`google-ai`** on
provider **`google-genai`**, base URL `https://generativelanguage.googleapis.com`.
This backs the Gemini model offerings and is separate from the Myra/agent
`openai-compatible` credential.

Verify in admin-ui (Tenants → your org → Providers / Credentials):

- Provider `google-genai` has `metadata.baseURL` =
  `https://generativelanguage.googleapis.com`
- Credential name is exactly `google-ai`

Gemini API keys are **not** read from hub runtime environment variables. They must
be seeded into the database via the script above (or added manually in admin-ui).

**Bluesky**: the public search endpoint now requires authentication. Create an app
password at **bsky.app → Settings → Privacy and Security → App Passwords** (separate
from your account password, revocable), then set `BLUESKY_HANDLE` (e.g.
`yourhandle.bsky.social`) and `BLUESKY_APP_PASSWORD`. Both must be present — if the
password is set without the handle, the Bluesky entry is skipped with a warning. Without
this credential the Bluesky search tool falls back to unauthenticated and returns 403.

Entries without a key set in the environment are skipped silently. Running the script again after adding new keys is safe — 409 responses (provider or credential already exists) are treated as no-ops.

---

## Step 6 — Verify the deployment

1. Open `https://<web domain>` and sign in with a Google account matching `GOOGLE_ALLOWED_DOMAINS`
2. The hub auto-provisions your Myra instance on first sign-in
3. Open Myra chat — if it loads and responds, the hub, sidecar, and credentials are all wired up correctly

Check hub logs for any `launchError` output on the first `/v1/me` request. A `resolveCredentialRequirement failed` error means the credential name does not match the agent definition's requirement (`Myra LLM` for agents).

---

## Operational Runbooks

### Add a workbench

A workbench is a sub-tenant of the global org. Create one via script or directly via the hub API.

**Via script:**

```bash
HUB_URL=https://<hub domain> \
HUB_COOKIE="<session cookie from browser DevTools>" \
bun run scripts/create-workbench.ts --name "Acme Corp"
```

Alternatively, pass `--url` and `--cookie` as flags:

```bash
bun run scripts/create-workbench.ts \
  --name "Acme Corp" \
  --url https://<hub domain> \
  --cookie "<better-auth.session_token=...>"
```

**Via API (curl):**

```bash
curl -X POST https://<hub domain>/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -H "Cookie: <session cookie>" \
  -d '{"name": "Acme Corp"}'
```

Returns `{ tenantId, tenantSlug, tenantName }`.

### Add a workbench-scoped credential

Credentials stored at the workbench (sub-tenant) level override org-level credentials for agents running in that workbench. Use this to give one workbench a different LLM key.

1. In admin-ui: Tenants → select the workbench tenant → Credentials → Add credential
2. Use the same provider name and credential name as the org-level credential (`Myra LLM`)

Interchange's ancestor-chain resolver finds the nearest match — the workbench credential takes precedence over the org credential.

### Rotate a credential

1. In admin-ui: Tenants → Credentials → select the credential → Edit
2. Update the API key field
3. Agents pick up the new key on their next session launch (or relaunch)

### Relaunch a stuck agent instance

If an agent is stuck in `deployed` status after a deploy or crash, hit the launch endpoint:

```bash
curl -X POST https://<hub domain>/api/v1/instances/<instanceId>/sessions \
  -H "Content-Type: application/json" \
  -H "Cookie: <session cookie>" \
  -d '{}'
```

Or sign in to the web UI — the `/v1/me` endpoint relaunches Myra automatically on every page load when the instance is not running.

### Diagnose and fix provider baseURLs

If inference fails with a `credential_failure` / HTTP 401 that names a provider
you are **not** using (e.g. an OpenAI "find your API key at platform.openai.com"
error while pointing at an openai-compatible endpoint), the credential is bound
to a provider row whose `baseURL` is stale. Inference reads `baseURL` from the
provider the credential is bound to — not from the credential's own metadata —
so a single stale provider row routes the right key to the wrong endpoint.

Use the **admin CLI** (`bun run admin:production` or `admin:staging`; see
[`docs/ADMIN_CLI.md`](docs/ADMIN_CLI.md)) against the affected tenant (usually
the **global** org tenant for Myra/Oat):

1. **Seed tool credentials from env** — ensures tenant-owned LLM credentials match
   your env keys and provider metadata.
2. **Seed model catalog** — rebuilds `model_provider` rows (including `baseURL`
   from credential metadata). The seeder does not patch an existing provider in
   place; delete the stale catalog provider in admin-ui first if you need a clean
   re-bind, then re-run the seed.

Inspect providers and credentials in **admin-ui** (Tenants → Providers /
Credentials) when you need a cross-tenant audit the CLI does not surface.

`baseURL` is resolved at session launch, so relaunch affected agents afterward
(delete + reload, or the relaunch runbook above) to pick up the new endpoint.

### Reset a user's Myra (no admin-ui)

When a user's personal agent (Myra) is wedged and admin-ui (Google auth) is
unavailable, delete the instance via the hub API so the sidecar session is torn
down and the `memberAgentInstance` mapping is removed. The next `/api/v1/me` (a
web app reload) re-provisions a fresh Myra and auto-relaunches it.

**Via admin CLI** (recommended): set the **user's** session cookie, not the
superadmin account:

```bash
HUB_URL=https://<hub domain> \
SESSION_TOKEN=<__Secure-better-auth.session_token from the browser> \
bun run admin:production
```

Select the user's tenant → **Agents** → **List agent instances** → note Myra's
`instanceId` → **Delete an agent instance** (same tenant and id). Then reload the
web app.

**Via curl** (same auth):

```bash
# List instances (find Myra's instanceId in the response)
curl -s "https://<hub domain>/api/v1/tenants/<tenantId>/agents/instances" \
  -H "Cookie: __Secure-better-auth.session_token=<token>"

curl -X DELETE \
  "https://<hub domain>/api/v1/tenants/<tenantId>/agents/instances/<instanceId>" \
  -H "Cookie: __Secure-better-auth.session_token=<token>"
```

### Add a new agent definition

1. Follow the "Adding a New Agent" steps in `DEV.md`
2. Deploy hub + sidecar together (they must be in sync)
3. On first boot, `seedAgentTemplates` idempotently adds the new definition to the global tenant
4. The definition appears in admin-ui → Agent Definitions immediately

To enable the new agent by default for all new users, add its definition key to the `enabledTemplates` list in `packages/agents/src/index.ts` and redeploy.

### Run the global-tenant data migration (existing deployments only)

If you are upgrading from the old per-user personal-tenant model, run this once after deploying:

```bash
# Dry run first — logs counts, writes nothing
bun --env-file=.env run apps/hub/src/scripts/migrate-to-global-tenant.ts

# Live run once the dry-run output looks correct
bun --env-file=.env run apps/hub/src/scripts/migrate-to-global-tenant.ts --live
```

This is idempotent and safe to re-run if interrupted.

### Update the interchange version

The Dockerfile pins the interchange branch:

```dockerfile
git clone --depth 1 --single-branch --branch v0.1.2 \
  https://github.com/faremeter/interchange.git interchange
```

Update the `--branch` tag in `apps/hub/Dockerfile` and `apps/sidecar/Dockerfile` to the new version, then redeploy hub and sidecar together.

---

## Troubleshooting

**Agents fail with "No sidecar connected"**
The sidecar has not connected to the hub yet, or they are on incompatible versions. Check that hub and sidecar are deployed from the same commit. Check sidecar logs for WebSocket connection errors.

**"resolveCredentialRequirement failed" in hub logs**
The agent's credential requirement name (`Myra LLM`) does not match any tenant-owned credential. Verify the credential name in admin-ui matches exactly, including case.

**"Instance is not running" (409) on chat**
The agent instance needs to be relaunched. This happens automatically on the next `/v1/me` call. If it persists, check hub logs for `launchError` — typically a missing or misconfigured credential.

**Google OAuth redirect mismatch**
The redirect URI in Google Cloud Console must be `https://<web domain>/api/auth/callback/google`, matching `BETTER_AUTH_BASE_URL` (your public web origin, not the internal hub hostname).

**Google sign-in works on desktop but fails on mobile (`state_mismatch`)**
The web app is calling the hub API cross-site (`VITE_API_BASE_URL` pointed at the hub). Mobile browsers block the OAuth state cookie. Fix: set hub `BETTER_AUTH_BASE_URL` and `SUPPORTED_CORS_ORIGINS` to the **web** URL, set web runtime `HUB_URL` to the hub, rebuild web **without** `VITE_API_BASE_URL`, and update the Google OAuth redirect URI to the web callback URL above.

**Sidecar loses agent state after redeploy**
The persistent volume at `SIDECAR_DATA_DIR` was not mounted or was wiped. Recreate it and redeploy. Agents will re-register; existing DB rows are preserved. If the hub also lost `HUB_DATA_DIR`, the trust relationship must be re-established — delete and re-create the sidecar token.
