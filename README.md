# GTM Workbench

## Setup

For the full agent loop, install the **ABK Agents** plugin locally:

```bash
/plugin install abklabs-agents
```

Then reload plugins:

```bash
/reload-plugins
```

## Deploying the API (Railway)

1. Create a new Railway project and add a service from this repo.
2. Add a **Postgres** plugin to the project — Railway injects `DATABASE_URL` automatically.
3. Enable public networking: **Settings → Networking → Public Networking → Generate Domain**. Note the generated URL (e.g. `https://your-api.up.railway.app`). This step cannot be automated via `railway.toml`.
4. Set environment variables on the API service:
   - `BETTER_AUTH_SECRET` — generate a random secret (e.g. `openssl rand -hex 32`)
   - `BETTER_AUTH_BASE_URL` — the API's public URL from step 3
   - `SUPPORTED_CORS_ORIGINS` — the web app's public URL (set after deploying the web app)
   - `OPENAI_COMPATIBLE_API_KEY`
   - `OPENAI_COMPATIBLE_MODEL`
5. Deploy. The `preDeployCommand` in `railway.toml` runs database migrations automatically before each deploy.

## Deploying the Web App

The web app is a static Vite build and can be deployed to either Railway or Vercel.

### Option A: Vercel

1. Import the repo in Vercel. Set the root directory to `apps/web`.
2. Set the build command to `bun run build` and output directory to `dist`.
3. Set environment variables:
   - `VITE_API_BASE_URL` — the API's public URL
4. Deploy. On each push to `main`, Vercel rebuilds and redeploys automatically.
5. Note the Vercel deployment URL and add it to `SUPPORTED_CORS_ORIGINS` on the Railway API service.

### Option B: Railway

1. Add a second service to the same Railway project from this repo.
2. Enable public networking on the web service and note the URL.
3. Set environment variables:
   - `VITE_API_BASE_URL` — the API's public URL
4. Set the build command to `bun install && bun run --filter @gtm/web build` and start command to serve the `apps/web/dist` directory (e.g. via `bunx serve apps/web/dist`).
5. Add the web service's public URL to `SUPPORTED_CORS_ORIGINS` on the API service.
