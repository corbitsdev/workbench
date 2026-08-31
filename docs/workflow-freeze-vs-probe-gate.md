# `@corbits/workflow-freeze` vs the sidecar probe gate

Analysis for CL-7273. Read against the vendored pin `a8bc06ae`.

## The claim under test

CL-7273 was filed on the claim that `@corbits/workflow-freeze` _reimplements_ the
freeze computation that `vendor/intx/hub-sessions/src/workflow-probe-gate.ts`
owns, and that the two will silently drift.

**That claim does not survive reading the imports.** `workflow-freeze` does not
reimplement the freeze. It composes the same native primitives, from the same
packages, for an input shape the probe path cannot produce.

## What `workflow-freeze` actually imports

Every load-bearing step comes from `@intx/*`:

| Step                           | Primitive                       | Package                            |
| ------------------------------ | ------------------------------- | ---------------------------------- |
| Reify the definition           | `projectLiveToInert`            | `@intx/workflow`                   |
| Walk the grant surface         | `walkCapabilities`              | `@intx/workflow-deploy`            |
| Director registry for the walk | `createDefaultDirectorRegistry` | `@intx/agent`                      |
| Compute the frozen hash        | `computeWireDefinitionHash`     | `@intx/types/wire-definition-hash` |
| Persist the freeze             | `createDbFrozenApprovalWriter`  | `@intx/hub-sessions`               |

The last two are the ones that matter, and they are shared with the probe path by
identity, not by imitation:

- `workflow-probe-gate.ts:454` calls `persist: createDbFrozenApprovalWriter(args.db)`.
  `workflow-freeze` calls the _same exported function_.
- `workflow-probe-gate.ts:40` imports `computeWireDefinitionHash` from the same
  module path `workflow-freeze` does, and recomputes with it at line 233.

So the hash preimage and the all-or-nothing stamp — the two places a drift would
actually cause damage — are one implementation, not two.

## What genuinely differs

Two things, both by necessity rather than duplication:

1. **The input.** The probe path receives a projection produced by a sidecar child
   evaluating live code. `workflow-freeze` receives a hub-authored definition that
   is _already inert JSON_ (an agent from the Agents page, a template block). There
   is no probe round-trip to ride because there is no code to evaluate.
2. **The approval policy.** The probe path gates on the operator approval walk.
   `workflow-freeze` self-approves, which the probe gate's own comments document as
   the analogue for live-authored definitions — the hub authored the bytes, so
   there is no third party whose approval is being assumed.

## The bug this package fixed

Before it, hub-authored paths called bare `ensureWorkflowDefinitionForAsset`, which
left `approved_wire_hash` / `grant_snapshot` / `wire_projection` NULL — permanently
unlaunchable rows (CL-6447, CL-6439). The package exists to route those paths
_into_ the native freeze, not around it.

## Existing test coverage

`packages/workflow-freeze/src/index.test.ts` already asserts the property CL-7273
asked for a drift test to establish:

```
expect(frozen.wireHash).toBe(await computeWireDefinitionHash(frozen.projection));
```

That pins the hash to the native function over the inert projection, and a
companion assertion pins that hashing the _raw_ JSON produces a different preimage
— which is the actual failure mode worth guarding (freezing a hash no launch-time
reader can recover). The DB half is covered against real Postgres in
`test/freeze.drizzle.test.ts`.

A cross-path test freezing the same definition through both routes would need a
running sidecar to produce the probe half. Given both routes already call one
`createDbFrozenApprovalWriter` and one `computeWireDefinitionHash`, that test would
be asserting that a function equals itself.

## Conclusion

No change recommended. This package is the pattern AGENTS.md holds up as correct
— product owns the composition, the platform owns the mechanism — and is closer to
`packages/approvals` (explicitly cited as clean) than to the `mintRepoGrant` drift
that CL-7256 exists to fix.

CL-7273 should be closed as "not a reimplementation".

## What would change this

If either path stopped calling the shared primitives — a local hash helper, a
hand-rolled stamp — the drift risk returns immediately. That is the thing worth
enforcing, and it belongs in the parent check (CL-7257) as "these two call sites
must import the same freeze primitives", not as a bespoke test here.

## Not verified

- Whether the self-approve policy is correct in every case it is reached. This
  analysis took the probe gate's own documented analogue at its word rather than
  auditing each caller's authority.
