# Client Standup Runbook

How to stand up an isolated GTM Workbench deployment for a client.

## Quick deploy (TL;DR)

Standing up a client, once the manifest exists, is short:

1. In Railway, create a project for the client and add the **hub** and
   **sidecar** services from this repo, each using its committed `railway.toml`
   (Config-as-Code). Add the Postgres plugin and a `/data` volume on each. (The
   web app is deployed separately — see the Model section.)
2. Generate the hub's public domain; if the web app is served from a separate
   origin (e.g. Vercel), note its URL too. Paste both into `clients/<slug>.toml`
   under the target environment.
3. `railway link` to the project, then apply the variables:
   ```
   bun run scripts/provision-client.ts <slug> production --apply
   ```
   This creates the environment if needed, generates the secrets, resolves the
   wiring, and sets every variable on the hub and sidecar. Run it again with
   `staging` for a staging environment.
4. Deploy. Promote the first owner (`seed-prod`), then set the client's
   credentials in the Owner UI.

Everything below is the detail behind those steps. Run
`bun run scripts/provision-client.ts <slug> <env>` (no `--apply`) first to print
the plan and eyeball it.

## Model

- **One isolated stack per client.** The provisioning script manages two Railway
  services — **hub** and **sidecar** — plus a Postgres plugin and a `/data`
  volume on each. Same code image for every client; a stack becomes a distinct
  client org purely through its environment.
- **The web app is deployed separately, and the script never touches it.** Today
  the web SPA is hosted on **Vercel** (which proxies `/api` to the Railway hub);
  it could also be baked into the hub image and served same-origin (a future
  option). Either way it is not a Railway service the provisioning script
  configures. The script only needs to know the **public app URL** (the origin
  the browser uses) to set the auth base and CORS.
- **Per-client configuration has two layers:**
  - **Layer 1 — deployment env** (this runbook): tenant identity + the
    secret/URL wiring graph. Base config lives in the client manifest; the
    provisioning script turns it into Railway variables.
  - **Layer 2 — Owner UI** (post-deploy, self-serve): each client's own LLM and
    tool credentials, and workflow enable/disable. Managed independently of code
    and independently of the manifest.
- **Tools are identical everywhere; credentials are the gate.** Every tool ships
  to every workbench via code. What Myra can actually use is gated purely by
  which credentials are configured — and credentials are set in the Owner UI, per
  deployment. The manifest says nothing about tools or credentials.
- **Permanent bootstrap (cannot move to the UI):** the env-seeded root tenant
  (`GLOBAL_TENANT_*`, seeded at hub boot) and the first owner (someone must hold
  the `owner` role before they can log into the Owner section).
- **Identical for every client (code, not config):** agents, system prompts,
  models, tools, and workflows. Per-client agent differentiation is not built
  yet — see the deferred config-layer issue.

---

## Part A — Per-client profile

### Where the profile lives

Each client has **one committed manifest** at `clients/<slug>.toml`. See
[`clients/example.toml`](../clients/example.toml) for the template.

The manifest is **base deployment config only** — tenant identity and public
URLs, per environment. Three things are deliberately NOT in it:

- **Secrets** (`BETTER_AUTH_SECRET`, `HUB_SIGNING_KEYS`, `SIDECAR_TOKEN`) →
  generated at standup, stored **only in Railway**. Never committed.
- **Credentials** (LLM + tool API keys) → set in the **Owner UI**, per
  deployment. All tools ship everywhere; credential presence gates what Myra can
  use, so credentials never appear here.
- **Build/deploy config** (Dockerfile, watch patterns, preDeploy, healthcheck) →
  the committed `apps/*/railway.toml`, via Railway Config-as-Code.

So the manifest is small and safe to commit. TOML is chosen to match the
`railway.toml` files and because it parses at runtime with no dependency and no
dynamic import (`Bun.TOML.parse(await Bun.file(path).text())`).

> This lives in the app repo for now because the provisioning script that
> consumes it lives here too. Extract `clients/` to a separate ops/config repo
> once the roster is noisy in app PRs or needs different access control — not
> before.

### Profile fields

One block per Railway environment (a client gets a `production` and, optionally,
a `staging` environment in the same project). Each environment is a **distinct
org** — its own name, slug, and domain, not just its own URLs.

```toml
# clients/<slug>.toml — NON-SECRET base config for one client.
[environments.production]
name = "Acme Corp"  # GLOBAL_TENANT_NAME — display name for this environment
slug = "acme"       # GLOBAL_TENANT_SLUG — kebab, unique per deployment
domain = "acme.com" # GLOBAL_TENANT_DOMAIN — same-domain users auto-join
hub_url = "https://<hub>.up.railway.app" # the Railway hub's URL (filled in step 2)
# web_url is OPTIONAL — the public app URL when the SPA is served from a separate
# origin (e.g. Vercel). It becomes the auth base + CORS origin. Omit it when the
# hub serves the SPA itself; then the hub URL is the public origin.
web_url = "https://<app>.vercel.app"

[environments.staging]
name = "Acme Corp Staging"
slug = "acme-staging"
domain = "acme.com"
hub_url = "https://<hub-staging>.up.railway.app"
web_url = "https://<app-staging>.vercel.app"
```

The provisioning script derives every hub + sidecar variable and the secrets from
these fields — see [`clients/example.toml`](../clients/example.toml).

### The wiring graph (the failure point)

The script derives these from the manifest. `public_origin` = `web_url` if the
web app is served separately, else the hub URL. Get one wrong and the stack
builds green but is silently broken (auth loops, CORS rejects, "no sidecar
connected"):

| Value                    | Derived from                                        | Consumed by                             |
| ------------------------ | --------------------------------------------------- | --------------------------------------- |
| `BETTER_AUTH_BASE_URL`   | = `public_origin` (`web_url` ?? `hub_url`)          | hub                                     |
| `SUPPORTED_CORS_ORIGINS` | = `public_origin`                                   | hub                                     |
| `HUB_WS_URL`             | = `hub_url`, `https`→`wss`, path `/api/sidecars/ws` | sidecar (always the hub, never the web) |
| `SIDECAR_TOKEN`          | one generated secret                                | hub **and** sidecar — must be identical |

`VITE_API_BASE_URL` is intentionally not here — the SPA is same-origin (either the
hub serves it, or the separate host proxies `/api`), so the web build leaves it
unset and manages its own build vars wherever it deploys (e.g. Vercel).

---

## Part B — Standup runbook (ordered)

### 1. Create the Railway project and services

- New Railway project for the client.
- Add the **hub** and **sidecar** services from this repo, each with **Root
  Directory = `/`** (the repo root is the Docker build context) and Config-as-Code
  pointing at `apps/hub/railway.toml` and `apps/sidecar/railway.toml`.
- Add the **Postgres** plugin (injects `DATABASE_URL` into the hub).
- Add a **Volume** to the hub (mount `/data`) and to the sidecar (mount `/data`).
- Deploy the **web app separately** (Vercel, per the current ABK Labs setup — it
  proxies `/api` to the hub). It is not part of this Railway project.

### 2. Capture public URLs

Generate the hub's public domain. If the web app is served from a separate origin
(e.g. Vercel), note its URL as `web_url`; omit `web_url` if the hub serves the
SPA itself. Record them in the manifest.

### 3. Provision the environment variables

From a checkout with `railway link` pointed at the client's project:

```
# Print the plan and eyeball it (no changes made):
bun run scripts/provision-client.ts <slug> production

# Apply it — creates the environment if needed, generates the secrets,
# resolves the wiring, sets every variable on the hub and sidecar:
bun run scripts/provision-client.ts <slug> production --apply
```

The script owns **only the hub + sidecar variables and the Railway environment**.
It generates `BETTER_AUTH_SECRET` / `HUB_SIGNING_KEYS` / `SIDECAR_TOKEN`, sets the
identical `SIDECAR_TOKEN` on hub and sidecar, sets `BETTER_AUTH_BASE_URL` and
`SUPPORTED_CORS_ORIGINS` to the public origin, derives `HUB_WS_URL` from the hub
URL, and sets the `GLOBAL_TENANT_*` identity. It never sets `DATABASE_URL` (the
Postgres plugin injects it), never sets any `VITE_*` var (the web build owns
those), and never touches build/deploy config (the committed `railway.toml`).
Re-running is safe: existing secrets are preserved, not rotated.

For a staging environment, run the same command with `staging`.

Optional hub variables not managed by the script (set in Railway if you want
them): `SEED_CREDENTIALS_ON_STARTUP=true`, `AUTO_JOIN_TENANT_SLUGS=<slug>`.

### 4. Deploy

Deploy the stack. On the hub, `preDeployCommand` runs
`scripts/db-setup.ts` (migrations) then `apps/hub/bin/seed-startup.ts`. At boot
the hub seeds the root tenant (`seedGlobalTenant`) and the agent definitions
(`seedAgentTemplates`) — both idempotent. The hub only passes `/health` after
boot completes (healthcheck timeout is 300s by design), so allow a few minutes.

### 5. Bootstrap the first owner + credentials

- **5a. First owner.** After the operator signs in once (OAuth), promote them to
  `owner` via the seed path (`SUPERADMIN_EMAIL` + `GLOBAL_TENANT_SLUG`,
  `apps/hub/bin/seed-prod.ts`). This is the one step that cannot be self-served —
  nobody can enter the Owner UI until an owner exists.
- **5b. Credentials.** The owner logs into the **Owner** section and sets the
  client's LLM credential (Catalog tab) and any tool credentials (Capabilities
  tab). All tools are already deployed; setting a credential is what makes its
  tool usable to Myra.

### 6. Verify

- Hub `/health` returns healthy; web loads.
- Operator can sign in and reach the app.
- A same-domain user auto-joins (or is invited) and their Myra launches and
  replies (confirms the LLM credential resolves).
- A workflow run starts and completes (confirms the sidecar link and workflow
  publish).

---

## What this does not cover yet

- **Project + service creation.** Step 1 (create the Railway project, the three
  services, the Postgres plugin, the volumes, and the public domains) is still
  done by hand in the Railway dashboard. The `provision-client` script picks up
  from there — it manages variables and environments, not infrastructure.
- **First-owner bootstrap** (step 5a) stays a manual seed step by design.
- **Per-client agent differentiation.** Enabled agents, per-agent model, and
  prompt variables (client name, brand voice) are identical across clients until
  the deferred config layer is built.
