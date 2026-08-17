# Running fully local (Ollama)

Workbench can run with no cloud LLM key at all, using a local
[Ollama](https://ollama.com) instance as the inference provider.

Set `OLLAMA_BASE_URL` in `.env` to the origin your Ollama instance listens
on (e.g. `http://localhost:11434`, or a tailscale-tunneled origin) — see
`apps/hub/src/config.ts`. Unlike every other provider, Ollama needs no key:
its mere presence auto-plants a probed catalog credential on the operator
bench at hub start. Each provider gets its own URL/key card in onboarding;
Ollama's is the one that asks for a base URL instead of a token.

Tool-heavy turns (anything that calls `mcp_list_tools`, dispatches a task,
or chains several tool calls) take noticeably longer — minutes, not
seconds — on small local models. This is a model-capability limit, not a
platform bug; expect it when testing against a small Ollama model.

## Migrations after pulling

`bun run dev` applies both the platform's own migrations and every
installed package's migrations at startup (`scripts/db-setup.ts`), reporting
what it applied. After pulling changes that add a migration, just restart:

```sh
bun run dev
```

No separate migrate command is needed — `dev` is safe to re-run and only
applies what hasn't already run.

## Republishing a tool package

A workflow that pins a `@corbits/*` tool package (e.g. **assistant** pinning
`@corbits/memory-tools`) resolves that pin from a `package-registry` asset
(`CORBITS_TOOLS_REGISTRY`) carrying the package's tarball, built by
`@corbits/tool-registry-publish`. `bun run seed` (`packages/hub-client/src/seed.ts`)
republishes that tarball every time it runs, so after changing a tool
package's source, republish and redeploy with:

```sh
bun run seed
```

This is safe to re-run.

## Memory plane

The memory plane (embeddings-backed recall) needs `EMBED_BASE_URL` set;
without it, `apps/hub/src/memory-mount.ts` skips mounting the memory plane
and logs that it did, rather than failing hub startup.
