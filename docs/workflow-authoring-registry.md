# Workflow authoring registry

Notes on `@corbits/workflows`'s `authoring/registry.ts`.

## What it is

An agent's in-tenant surface for publishing a workflow codebase as a native
`kind:"workflow"` hub asset, republishing it, and reading it back. Every
write is gated by own-tenant scoping plus an explicit grant-store
authorization call, and by `validateWorkflowSourceTree` before anything
reaches `RepoStore`. Deploying is not this registry's job — an agent deploys
a committed asset through the stock deployments route with the run bearer.

## Why `populateAsset` uses the `hub` principal

`workflowKindHandler.workflowAuthorize` only recognizes three principal
kinds for a workflow-asset write: `hub` (full access), `sidecar`
(read-only), and `user` (gated by git-token-shaped bearer claims a
sidecar-authenticated caller never carries). There's no fourth
"workflow-run" principal kind the substrate understands, so the real
per-write authorization decision has to be made here, by this registry,
against the grant store and the resolved caller identity — before the
already-authorized write is handed to the substrate as a hub-mediated
commit under `hub` (the same principal `@corbits/skills`'s `writeSkillMd`
uses).

## Why head-sha reads go through `RepoStore` directly

`AssetService` exposes blob and directory reads pinned to a ref but never
the sha that ref resolves to, and `listAssetBlobs` lists blobs only (no
subtrees), so a full tree walk needs `RepoStore.openCommittedReads`. The
repo id is the asset id under the `workflow` kind, exactly as `AssetService`
composes it internally.
