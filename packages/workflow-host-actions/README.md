# @corbits/workflow-host-actions

Host bindings for the action/loop seam `@intx/workflow`'s
`WorkflowRuntimeEnv` leaves to the host
(`invokeAction` / `effects` / `loopFns` / `runLoopIteration`). Upstream
defines the slots but never populates them in the production child host;
this package supplies the production implementations, droppable on any
Interchange instance.

## Surfaces

- `createActionHandlerRegistry(handlers)` /
  `createLoopFnRegistry(fns)` — typed, fail-closed registries. An
  unregistered ref throws with the ref name; `{}` yields a default that
  refuses every ref, so an action-free deployment wires nothing and a
  stray `action`/`loop` step fails its run loudly instead of silently.
- `createWorkflowActionInvoker({ authorize, effects, resolveHandler })` —
  the runtime-env `invokeAction` surface. Resolves the step's `handler`
  ref, builds a capability- and ledger-checked `EffectContext`, and runs
  the handler.
- `createWorkflowRunEffectLedger(opts)` — durable, exactly-once
  `EffectLedger` for one run, committed through the workflow-run
  substrate under `runs/<runId>/blobs/` (append-only kind-handler
  layout). Envelope bytes read back off disk are parsed with arktype,
  never asserted.
- `writeRunBlob` / `readRunBlob` / `blobsPrefixFor` / `isErrnoNotFound` —
  the shared `runs/<runId>/blobs/` read/write helpers the ledger rides.

## Dependencies

Only `@intx/workflow` (runtime contracts), `@intx/hub-sessions`
(substrate), `@intx/types`, and arktype — no workbench coupling.
