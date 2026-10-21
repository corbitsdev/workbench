# Self-host

How to run Corbits Workbench yourself: what you need, how to run the container image, first sign-in setup, and every setting. Local development is in [local-dev.md](local-dev.md).

## What you need

To try it on your machine with [Docker Compose](#docker-compose):

- Docker.
- One inference provider connected after sign-in: an API key (Anthropic, OpenAI, Google, xAI, OpenRouter, or any OpenAI-compatible endpoint), a subscription login (Codex or xAI), or a local [Ollama](https://ollama.com) instance with no key.

A real deployment also needs:

- Postgres 17 with `pgvector` (`pgvector/pgvector:pg17`), required by `@corbits/memory`.
- One machine or container for the hub, built from the root `Dockerfile`, with a persistent volume for `HUB_DATA_DIR` and a public HTTPS domain. When `WEB_DIST_DIR` is set (as the `Dockerfile` sets it), the hub serves the built web client, the API (`/api/...`), and inbound webhooks (`/api/hooks/...`) on that single origin.

Size the hub for its sidecars: the hub spawns local sidecars as Bun child processes (`apps/sidecar/src/index.ts`), one per active workflow allocation.

## Run it

### Docker Compose

`compose.yml` runs Postgres 17 (with `pgvector`) and the hub at `http://localhost:3000`. In `.env`, set the four 32-byte hex secrets; Compose sets `DATABASE_URL`, `HUB_DATA_DIR`, `PORT`, and `BETTER_AUTH_BASE_URL`, and applies the [database role](#database-role) timeout.

```sh
cp .env.example .env
# Generate four distinct 32-byte hex secrets (openssl rand -hex 32 each):
#   CREDENTIAL_ENCRYPTION_KEY, PRINCIPAL_KEY_ENCRYPTION_KEY,
#   SIDECAR_CREDENTIAL_ENCRYPTION_KEY, BETTER_AUTH_SECRET
docker compose up --build -d
docker compose logs -f hub
```

Open `http://localhost:3000` once the hub logs `Starting server on port 3000`.

### Railway

1. Create a project and add a Postgres service with the `pgvector` extension enabled (for example the `pgvector/pgvector:pg17` image).
2. Add the `hub` service from this repository. It builds the root `Dockerfile`.
3. Generate a public domain on port `3000` and mount a persistent volume at `/data`.
4. Set the environment variables on `hub` (each secret is a distinct `openssl rand -hex 32`):

   ```sh
   railway variable set --service hub \
     BETTER_AUTH_SECRET=<hex> \
     CREDENTIAL_ENCRYPTION_KEY=<hex> \
     PRINCIPAL_KEY_ENCRYPTION_KEY=<hex> \
     SIDECAR_CREDENTIAL_ENCRYPTION_KEY=<hex> \
     'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
     BETTER_AUTH_BASE_URL=https://<your-domain> \
     HUB_PUBLIC_URL=https://<your-domain> \
     HUB_DATA_DIR=/data \
     PORT=3000
   ```

5. Apply the [database role](#database-role) setting on Postgres.

### Render or any other container host

1. Provision Postgres 17 with `pgvector`. Add `?sslmode=require` to `DATABASE_URL` when reached over the public internet.
2. Build and run the root `Dockerfile` with a persistent disk mounted at `/data`.
3. Set the [required variables](#required) and any optional ones.
4. Terminate TLS in front of the hub on port `3000`.

### Database role

On every Postgres outside `compose.yml`, set `idle_in_transaction_session_timeout` on the hub's database role so wedged transactions release their locks after ten minutes:

```sql
alter role <hub role> set idle_in_transaction_session_timeout = '10min';
```

## First sign-in in the app

1. **Sign up.** Open the hub URL and create your account. Your first sign-in creates your workbench (a plain Interchange tenant) and deploys the default worker definition (`@corbits/worker`).
2. **Connect an inference provider.** Onboarding prompts for one provider—paste an API key (Anthropic, OpenAI, Google, xAI, OpenRouter), sign in with Codex or xAI, or point at a local Ollama URL (`http://localhost:11434/v1`). Provider keys live encrypted in the hub's vault and are never read from environment variables.
3. **Start a thread.** Message the workbench worker to run tasks, author workflows, or connect MCP servers and skills.

## Configuration

`.env.example` lists every supported variable. Secrets are runtime variables, never build arguments.

### Required

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `postgres://` or `postgresql://` connection string. The hub derives `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` from it when those individual variables are unset. |
| `HUB_DATA_DIR` | Directory for durable git repositories, workflow assets, and sidecar state. Mount a persistent volume here (e.g. `/data`). |
| `CREDENTIAL_ENCRYPTION_KEY` | 32-byte hex key (`openssl rand -hex 32`) that seals tenant credentials at rest. |
| `PRINCIPAL_KEY_ENCRYPTION_KEY` | 32-byte hex key (`openssl rand -hex 32`) that seals per-principal Ed25519 signing keys at rest. |
| `SIDECAR_CREDENTIAL_ENCRYPTION_KEY` | 32-byte hex key (`openssl rand -hex 32`) that sidecars use to seal their local run credential store, kept separate from the hub keys. |
| `BETTER_AUTH_SECRET` | 32-byte hex secret (`openssl rand -hex 32`) used by Better Auth to sign session cookies in production. |
| `BETTER_AUTH_BASE_URL` | Public URL users open in the browser (for example `http://localhost:3000` or `https://workbench.example.com`). Sign-up rejects requests from other origins with `Invalid origin`. |

### Web UI and networking

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port the hub listens on. |
| `WEB_DIST_DIR` | unset | Path to the built `apps/web/dist` bundle. Set to `/app/apps/web/dist` in the `Dockerfile` so the hub serves the SPA and static assets on the same origin. (`PORTAL_DIR` is accepted as an alias.) |
| `HUB_PUBLIC_URL` | `http://127.0.0.1:<PORT>` | Public hub origin that OAuth callbacks (such as MCP server OAuth logins) redirect back to. Set to your `https://` origin in production. |
| `HUB_SIDECAR_WEBSOCKET_URL` | `ws://127.0.0.1:<PORT>/api/sidecars/ws` | WebSocket URL local sidecars dial back to. |
| `HUB_MAX_TARBALL_BYTES` | `10485760` | Maximum tool-package tarball size accepted by the hub registry (bytes). |

### Memory plane (`@corbits/memory`)

Optional. When `EMBED_BASE_URL` and `OLLAMA_BASE_URL` are both unset, the hub boots normally without mounting vector recall.

| Variable | Default | Effect |
| --- | --- | --- |
| `EMBED_BASE_URL` | falls back to `OLLAMA_BASE_URL` | OpenAI-compatible or Ollama embeddings endpoint URL. |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model name. |
| `EMBED_API_KEY` | unset | Bearer key for the embeddings endpoint, if required. |
| `RERANK_BASE_URL`, `RERANK_MODEL` | unset | Optional Text Embeddings Inference reranker; set both or neither. |
| `RERANK_API_KEY` | unset | Bearer key for the reranker endpoint, if required. |

### Sign-in and OAuth adapters

| Variable | Default | Effect |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | unset | Enable "Continue with Google" sign-in. Set callback URI to `<BETTER_AUTH_BASE_URL>/api/auth/callback/google`. |
| `SIDECAR_ADAPTER_MANIFEST` | Codex + xAI adapters (see `.env.example`) | JSON array of `{provider, specifier, export}` adapters loaded by sidecars for non-stock providers. |

### Web UI hosted separately

If you host `apps/web/dist` on a static CDN instead of serving it from the hub via `WEB_DIST_DIR`:

- Unset `WEB_DIST_DIR` on the hub.
- Proxy `/api/*` from the web host to the hub's origin so requests stay same-origin, and set `BETTER_AUTH_BASE_URL` to the public URL users open in their browser.

## Backups

Back up all three together:

- **Postgres**: tenants, accounts, principals, grants, mailbox threads, artifacts, cron schedules, and encrypted credentials.
- **The `HUB_DATA_DIR` volume**: git repositories for workflow definitions, run history, and sidecar state.
- **The encryption keys** (`CREDENTIAL_ENCRYPTION_KEY`, `PRINCIPAL_KEY_ENCRYPTION_KEY`, `SIDECAR_CREDENTIAL_ENCRYPTION_KEY`, and `BETTER_AUTH_SECRET`): store them separately from the database backup. A database backup without the keys that sealed its vault cannot decrypt stored credentials or signing keys.
