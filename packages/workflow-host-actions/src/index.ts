// @corbits/workflow-host-actions — host bindings for the action/loop seam
// `@intx/workflow`'s `WorkflowRuntimeEnv` leaves to the host
// (`invokeAction`/`effects`/`loopFns`/`runLoopIteration`). Droppable on any
// Interchange instance: depends only on `@intx/workflow` for the runtime
// contracts and `@intx/hub-sessions`' substrate for durable storage.

export {
  createActionHandlerRegistry,
  createLoopFnRegistry,
  createWorkflowActionInvoker,
  type ActionHandler,
  type WorkflowActionInvokerOpts,
} from "./action-invoker";
export {
  createWorkflowRunEffectLedger,
  type WorkflowRunEffectLedgerOpts,
} from "./effect-ledger";
export {
  blobsPrefixFor,
  isErrnoNotFound,
  readRunBlob,
  writeRunBlob,
  type RunBlobStoreOpts,
} from "./run-blobs";
