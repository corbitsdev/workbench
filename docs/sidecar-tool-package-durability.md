# Sidecar tool-package apply durability

`apps/sidecar/src/tool-materialization.ts` applies a workflow's tool-package
manifest atomically and records which deploy is active. This covers the
durability protocol around that record.

## active-deploy-id file

Written as `v1:<deploy-id>`. The `v1:` prefix lets a future format change be
rejected loudly instead of misread; pre-versioning files with no prefix are
still accepted for one upgrade cycle, then that branch should be deleted
once every sidecar has restarted on a version that writes the prefix.

## Persist ladder

Persisting the new id is the commit for a staged apply. If the fsync'd write
fails, a no-fsync fallback write runs; if that also fails, a sibling
`.dirty` marker records the id instead. On boot, the dirty marker (if
present) is read in preference to the recorded id, since it means a prior
apply committed on disk but the id was not durably flushed. Each stage is
best-effort past the first: a degraded write is logged, not escalated,
since the deploy itself is already staged on disk.

## Rejected-apply audit

A rejected manifest (JSON parse failure, schema failure, or loader
rejection) is written verbatim to
`<storeDir>/audit/rejected-applies/<attemptId>/manifest.json` alongside an
`error.json` failure payload, fsynced before the caller throws. This
preserves the original bytes (whitespace, key order, unknown fields) for
replay against a newer validator, independent of anything the arktype
schema narrowed away.
