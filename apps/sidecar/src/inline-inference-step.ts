import { getLogger } from "@intx/log";
import type { Agent, AgentDefinition, AuthorizeFn, BaseEnv } from "@intx/agent";
import type { StepInvokeRequest } from "@intx/workflow";
import type { InferenceEvent } from "@intx/types/runtime";
import type { StepEnvBase } from "@workbench/workflow-host";
import {
  STEP_NONFATAL_TAG,
  STEP_INLINE_RETRY_MAX_TAG,
} from "@workbench/agents";

// The inline single-turn inference runner (CL-2251). This is WORKBENCH-OWNED
// code with no upstream counterpart; it lives here — not in the vendored
// `workflow-substrate-factory.ts` — so its logic never adds to the vendored
// re-sync surface, mirroring how `runDeterministicToolStep` lives in
// `step-tool-harness.ts`. The vendored step invoker only dispatches to it.

const logger = getLogger("workbench.sidecar.inline-inference-step");

/** Deny-all authorize for inline steps: they declare no tools, so any tool
 * authz must fail closed. */
const inlineDenyAllAuthorize: AuthorizeFn = async () => ({
  effect: "deny",
  matchingGrants: [],
  resolvedBy: null,
});

/**
 * Encode the step's resolved `input` as the agent's synthetic inbound message
 * content. Mirrors `@intx/workflow-host`'s step-invoker `synthesizeInputContent`
 * (not exported): a string passes through; any other value is JSON-stringified,
 * and a non-serializable input fails loud rather than sending "undefined".
 */
function synthesizeStepInput(input: unknown): string {
  if (typeof input === "string") return input;
  const encoded = JSON.stringify(input);
  if (encoded === undefined) {
    throw new Error(
      `inline inference step: input of typeof ${typeof input} is not JSON-serializable; the step's input selector must resolve to a serializable value`,
    );
  }
  return encoded;
}

/**
 * Run an inline single-turn inference step (CL-2251). Builds the per-step env
 * (pinning `sources`/`defaultSource` from the `STEP_INFERENCE_SOURCES` table),
 * instantiates a bare agent with a deny-all `authorize`, sends the step's
 * input, and returns the `{ reply, turn }` output shape the deployed inference
 * invoker returns. The agent is always torn down.
 *
 * A step tagged `STEP_NONFATAL_TAG` (via `inlineInferenceStep({ nonFatal })`)
 * degrades a failed turn to a completed `isError` output instead of failing the
 * run — the same contract `runDeterministicToolStep` provides — so a workflow
 * quorum can drop one dead variant and continue. Cancellation is never masked.
 */
export async function runInlineInferenceStep(args: {
  req: StepInvokeRequest;
  buildEnv: (req: StepInvokeRequest) => Promise<StepEnvBase>;
  agentFactory: <EnvReq extends BaseEnv>(
    def: AgentDefinition<EnvReq>,
    env: EnvReq,
  ) => Promise<Agent>;
  /**
   * WORKBENCH-LOCAL (CL-3379): per-step inference event sink, threaded from
   * the same `onEvent` the launched-step path forwards through
   * `onInferenceEvent` -> `publishInferenceEvent` (workflow-host-wiring.ts),
   * which carries the deployment's `agentAddress`/`sessionId` attribution.
   * Absent, no events are consumed beyond the drain (matches prior
   * behaviour); present, every non-`message.received` event is forwarded so
   * the heartbeat brief's per-member inline inference reaches
   * `analytics_event` the same way a launched step's does.
   */
  onEvent?: (event: InferenceEvent) => void;
}): Promise<{
  output: { reply: string; turn: unknown; isError?: boolean; error?: string };
}> {
  if (args.req.signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const envBase = await args.buildEnv(args.req);
  const env: BaseEnv = { ...envBase, authorize: inlineDenyAllAuthorize };
  const agent = await args.agentFactory(args.req.agent, env);
  // Attach a draining stream() consumer BEFORE send() so the agent's pre-start
  // event buffer drains instead of overflowing (CL-2253) and the step's live
  // progress events flow to the sidecar logs. The loop ends when close()
  // terminates the consumer; a StreamBackpressureError is caught and logged
  // rather than left to reject.
  //
  // WORKBENCH-LOCAL (CL-3379): forward every non-`message.received` event to
  // `args.onEvent` (when supplied) instead of discarding it, mirroring
  // `@workbench/workflow-host`'s `subscribeAgentEvents` filter/forwarding
  // contract for the launched-step path -- a throwing sink is logged and
  // swallowed so a downstream consumer's failure can never fail the step.
  const drainStream = async (): Promise<void> => {
    try {
      for await (const event of agent.stream()) {
        if (event.type === "message.received") continue;
        if (args.onEvent === undefined) continue;
        try {
          args.onEvent(event);
        } catch (sinkErr) {
          logger.error`inline inference step event sink threw forwarding ${event.type}: ${
            sinkErr instanceof Error ? sinkErr.message : String(sinkErr)
          }`;
        }
      }
    } catch (err) {
      logger.warn`inline inference step: event stream drain stopped: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  };
  const draining = drainStream();
  try {
    const sendResult = await agent.send(synthesizeStepInput(args.req.input));
    return { output: { reply: sendResult.reply, turn: sendResult.turn } };
  } catch (cause) {
    // Never mask cancellation: an aborted signal is the run cancel/timeout, not
    // a variant failure, so rethrow it.
    if (args.req.signal.aborted) throw cause;

    // A non-`nonFatal` step propagates the failure (the engine retries per its
    // RetryPolicy, then fails the run).
    const tags = args.req.agent.tags;
    if (tags?.[STEP_NONFATAL_TAG] !== "true") throw cause;

    // A `nonFatal` step with a retry policy must let the engine's RetryPolicy
    // exhaust before degrading — otherwise the isError return commits on the
    // first attempt and retry never fires. Throw on every attempt but the last
    // (the engine re-invokes with an incremented `attempt`); degrade to the
    // completed isError skip only once no attempts remain.
    const maxAttempts = Number(tags[STEP_INLINE_RETRY_MAX_TAG] ?? "1");
    const attempt = args.req.authzContext.attempt ?? 1;
    if (Number.isFinite(maxAttempts) && attempt < maxAttempts) throw cause;

    const reason = cause instanceof Error ? cause.message : String(cause);
    logger.error`inline inference step degraded to a non-fatal skip after ${attempt} attempt(s): ${reason}`;
    return { output: { reply: "", turn: null, isError: true, error: reason } };
  } finally {
    await agent.close();
    await draining;
  }
}
