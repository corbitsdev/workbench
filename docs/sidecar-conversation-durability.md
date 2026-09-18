# Warm-agent conversation durability

`apps/sidecar/src/conversation-state.ts` makes a warm single-step agent's
multi-turn conversation durable across a child respawn by mirroring it into
the workflow-run substrate instead of the agent's per-run isogit store.

## On-disk layout

```
agent-state/<agentKey>/
  checkpoint.json        compacted full snapshot (turns + metadata)
  checkpoint.meta.json   { checkpointSeq, turnCount, tokenUsage, ... }
  wal/<bucket>/<seq>.json  one per-boundary delta blob
```

The WAL is keyed by mirror boundary, not by turn, so a turnless
metadata-only boundary still commits an entry — keying by turn dropped
metadata on those boundaries, regressing the metadata-equivalence
invariant.

`bucket = floor(boundarySeq / WAL_BUCKET_SIZE)` bounds a directory's tree
size so no commit re-hashes a tree that grows with turn count. Compaction
every `CHECKPOINT_INTERVAL` boundaries folds the WAL into a fresh
checkpoint and truncates it, keeping per-boundary durable cost ~O(1)
amortized. Restore loads the checkpoint then replays the WAL tail,
concatenating turns and taking the latest entry's metadata.

## Substrate-merge constraint

`writeTreePreservingPrefix`'s `merge` callback receives only the direct
children of `preservePrefix`, and the substrate's `clearPrefix` recursively
removes the whole prefix subtree before writing the merge's return set.
WAL append uses `preservePrefix = agent-state/<key>/wal/<bucket>/` (no
isogit side-read needed); checkpoint write + WAL truncate uses
`preservePrefix = agent-state/<key>/` and simply omits `wal/...` paths from
the returned set to truncate atomically in the same commit.

## Timing and failure semantics

The mirror is still awaited synchronously at each run boundary — this is a
structure-only change to what the write does (O(1) append vs O(N) blob),
not when it happens. A restore that cannot parse/replay a checkpoint or WAL
throws rather than silently starting fresh; a mirror write failure
surfaces rather than leaving the next respawn to read a stale snapshot.
