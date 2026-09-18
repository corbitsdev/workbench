# Running fully local (Ollama)

Workbench can run with no cloud LLM key at all, using a local
[Ollama](https://ollama.com) instance as the inference provider. On the
first sign-in, pick "Ollama (local)": it asks for the base URL (default
`http://localhost:11434/v1`) and a model name you have pulled, and needs
no key. It rides Interchange's stock `openai-compatible` plugin. Set
`OLLAMA_BASE_URL` in `.env` too (e.g. `http://localhost:11434`): `bun run
dev` reads it to also mount the memory plane against the same origin when
`EMBED_BASE_URL` is unset.

Tool-heavy turns (several tool calls in one turn) take noticeably longer
on small local models. That is a model-capability limit, not a platform
bug.

## Migrations after pulling

`bun run dev` applies both the platform's own migrations and every
installed package's migrations at startup, reporting what it applied.
After pulling changes that add a migration, just restart:

```sh
bun run dev
```

No separate migrate command is needed — it is safe to re-run and only
applies what has not already run.

## Memory plane

The memory plane (embeddings-backed recall, `@corbits/memory`) needs an
embedding endpoint: an explicit `EMBED_BASE_URL` wins, otherwise
`OLLAMA_BASE_URL` is used, and `bun run dev` injects the native-Ollama
embed env when Ollama is on `PATH` and neither is set. Without any of
these the hub skips mounting the plane and logs that it did, rather than
failing startup; `memory_search`/`memory_add`/`memory_list` then answer
with a plain "memory isn't set up on this server yet" note.

Run `bun run setup:memory` for a machine-specific recommendation — it
checks for native Ollama and Docker, prints the exact env lines, and
writes missing `EMBED_*` keys into `.env` when a local embed path exists.
Setting `EMBED_BASE_URL` later does not retroactively embed anything
written while it was unset: migrations create the tables either way, but
there is no backfill.

An optional reranking pass (`RERANK_BASE_URL`/`RERANK_MODEL`) needs both
values set or neither — a half-configured reranker fails boot, but once
both are set a reranker outage degrades search quietly instead of
breaking it.

See `.env.example` for every memory-plane variable.

## Signing in to Codex and xAI

Both are subscription providers with no API key: onboarding offers
"Continue with Codex" and "Continue with xAI", and the hub runs the whole
loopback OAuth flow in its own process — the browser only ever sees the
authorize URL and, at the end, the id of the credential the hub stored.
Each provider pins its own loopback port (1455 for Codex, 1456 for xAI),
so those ports must be free on the machine running the hub, and the
browser must be on that same machine.

Serving inference with one of those credentials also needs the matching
adapter in the sidecar, which is what `SIDECAR_ADAPTER_MANIFEST` in
`.env.example` is for; the hub forwards it to every sidecar it spawns.
Leave it unset to run without those two providers.

Nothing refreshes an expired OAuth credential today. When one lapses, sign
in again from Settings to replace it.
