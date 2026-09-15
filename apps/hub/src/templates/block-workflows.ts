// The source form a catalog workflow deploys as when someone asks for it
// on demand — the instantiate path's block-workflow resolution
// (CL-6405) generalized to any catalog entry with a source package
// under `workflows/<name>` (CL-7073), not just `code-review`.
//
// HONEST GAP (CL-7585): the only build step this module ever adapted —
// the deleted seeding package's per-workflow `buildJson` closures (each
// one closing over its workflow package's trigger address and turn
// timeouts) — has no native home yet. Nothing in `apps/hub` may rebuild
// it (the lane fence), and rebuilding it inside the instantiate path
// would re-own seed behavior under a new name, so this builder answers
// `undefined` for every asset name. The route (`./template-block-routes.ts`) turns that into
// its existing 404 — no silent no-op, no fake deploy. The new home for
// the per-workflow builders is a follow-up lane's call (sibling
// template/instantiate owner); when it lands, it reimplements this
// builder against the tenant's real, ordered inference preferences and
// these 404s become deploys again — see the gap tests in
// `./template-block-routes.test.ts`.
//
// Server-only, on purpose: a future builder pulls in its workflow
// package (e.g. `@corbits/granola-call-workflow`) and with it
// `@intx/agent`/`@intx/workflow` — the heavy graph `./templates.ts`
// keeps every manifest consumer off. Only `./template-block-routes.ts`
// (mounted in `apps/hub`) imports this; it is deliberately not
// re-exported from the package root.

export interface BlockWorkflowBuildInput {
  readonly tenantDomain: string;
  readonly inferencePreferences: readonly {
    readonly provider: string;
    readonly model: string;
  }[];
}

export interface BlockWorkflowSource {
  readonly assetName: string;
  readonly displayName: string;
  readonly workflowJson: string;
}

/**
 * The serialized source-form definition for one catalog workflow — or
 * `undefined`, for every asset name, until the per-workflow builders get
 * their new home (see above). `assistant` (seeded, never redeployed
 * here) and `heartbeat` (test-only, never deployed onto a real bench)
 * always answer `undefined`, same as any name outside the catalog
 * entirely. A route answering `undefined` as a 404 is the honest
 * statement of that gap.
 */
export function buildBlockWorkflowSource(
  _assetName: string,
  _input: BlockWorkflowBuildInput,
): BlockWorkflowSource | undefined {
  return undefined;
}
