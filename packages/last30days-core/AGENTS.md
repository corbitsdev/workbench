# @workbench/last30days-core

Pure analytics core for the last30days feature. Stateless functions for clustering, deduplication, date filtering, entity extraction, ranking, and report generation — no I/O, no agent calls.

- All exports are pure functions; no side effects, no DB access
- The last30days workflow and the hub tools layer call into this; do not add HTTP or DB calls here
- `schema.ts` owns the ArkType schemas for all input/output types

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
