# Workbench templates

Each subdirectory is one shipped `WorkbenchDefinition`: the agents,
routines, webhook triggers, plugins, and onboarding walkthrough a
"pick a kind of workbench" row creates. `index.ts` is the single
description both `apps/web`'s picker and `./instantiate.ts` read — the
schema, the assembled `WORKBENCH_TEMPLATES` list, and the
parse/serialize helpers a bench-library row round-trips through.

- `gtm/` — the go-to-market workbench (CL-6349)
- `code-review/` — three reviewer lenses over every pull request
- `due-diligence/` — Scout plus Myra for research and follow-up

`./instantiate.ts` resolves a definition against a bench over injected
ports; `./settings.ts` is the `template/*` settings vocabulary a room
persists about the template it was minted from.
