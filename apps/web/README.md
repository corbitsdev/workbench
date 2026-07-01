# @workbench/web

React 19 + Vite frontend for GTM Workbench. Talks to `apps/hub` via REST + SSE.

## Dev

```bash
bun run dev   # from repo root, or:
bun run --filter @workbench/web dev
```

Local dev proxies `/api` to the hub (see `vite.config.ts`); leave `VITE_API_BASE_URL` unset unless you intentionally test cross-origin API calls.
