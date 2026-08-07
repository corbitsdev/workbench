// The channel workflow: the multi-turn definition whose long-lived run
// IS a channel. It parks awaiting mail at `triggerAddress`, and each
// inbound mail either updates participant state (a control message —
// see `relay.ts`) or relays onward to every other participant as
// single-recipient mail (hub-and-spoke).
//
// This package is installable data. It imports only published
// platform packages, and nothing imports it statically: a host
// publishes the serialized definition as a workflow asset and deploys
// it through the platform's deploy machinery; the execution host
// materializes it at runtime from the deploy alone.
//
// Modeled on `workflows/echo`'s `buildEchoWorkflow`/`serializeEchoWorkflow`
// split, but the section is an `onTrigger` body driving a deterministic
// `action` step rather than a single agent `step`: the relay is zero
// inference by requirement, so no `AgentDefinition` belongs anywhere in
// this definition.

import { action, defineWorkflow, onTrigger } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

export const CHANNEL_WORKFLOW_ID = "wf_channel";
export const CHANNEL_SECTION_ID = "inbound";
export const CHANNEL_RELAY_STEP_ID = "relay";

/**
 * The string ref an execution host resolves to the relay's `action`
 * handler, mirroring how a `step`'s `agent` is resolved by
 * `invokeStep`. Kept a string so the definition stays hashable and
 * JSON-portable; the handler itself lives in host wiring, not in this
 * package.
 */
export const CHANNEL_RELAY_HANDLER = "chat/channel-relay";

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific channel instance's inbox — Fork 3's
 * "a channel is an interactive instance launch of this definition" —
 * so a definition built here is per-channel by construction.
 */
export interface ChannelWorkflowInput {
  /** The channel's mail address; every mail to it is a run occurrence. */
  readonly triggerAddress: string;
  /** Per-occurrence timeout in milliseconds, enforced on the relay step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the channel definition. A single `onTrigger` section is the
 * entire body: the section IS the parked-awaiting-mail loop (the
 * platform's snapshot-less input park), and each mail occurrence runs
 * the body once as a child run sharing the one living workflow run's
 * state and event log — the channel's timeline.
 *
 * The body's only step is a deterministic `action`, never a `step`:
 * an `action` cannot carry an `agent`, which is the structural
 * guarantee that this definition performs zero inference. The action
 * declares the `mail:send` effect capability it needs to relay —
 * nothing else — so the deploy capability walk surfaces exactly that
 * grant for operator approval.
 *
 * The definition carries no `state.schema`: `WorkflowDefinition.state`
 * is untyped JSON asset data, and `relay.ts`'s `ChannelParticipantState`
 * is described with arktype `type()`, whose `Type` instances are
 * function-bearing and not JSON-portable — embedding one here would
 * make `serializeChannelWorkflow` fail on every definition. The action
 * handler owns reading and writing that state from the run's own
 * storage across occurrences; `relay.ts` is its pure, host-independent
 * core.
 */
export function buildChannelWorkflow(
  input: ChannelWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error("buildChannelWorkflow requires a non-empty triggerAddress");
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildChannelWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: CHANNEL_WORKFLOW_ID,
    steps: {
      [CHANNEL_SECTION_ID]: onTrigger({
        on: { type: "mail", to: input.triggerAddress },
        body: defineWorkflow({
          id: `${CHANNEL_WORKFLOW_ID}_${CHANNEL_SECTION_ID}`,
          steps: {
            [CHANNEL_RELAY_STEP_ID]: action({
              handler: CHANNEL_RELAY_HANDLER,
              effect: { requires: ["mail:send"] },
              timeout: input.turnTimeoutMs,
            }),
          },
        }),
      }),
    },
  });
}

/**
 * Serializes a definition to the JSON a workflow asset carries. The
 * definition must survive the asset round-trip byte-faithfully, so
 * anything JSON would silently drop or mangle — functions, undefined,
 * symbols, bigints, non-finite numbers, class instances — is a loud
 * error naming the offending path instead of a corrupted asset.
 *
 * `assertJsonPortable` is deliberately re-implemented here rather than
 * imported: `workflows/echo`'s copy is module-private, and this
 * package must not reach into another package's internals to get it.
 */
export function serializeChannelWorkflow(
  definition: WorkflowDefinition,
): string {
  assertJsonPortable(definition, "definition");
  return JSON.stringify(definition);
}

function assertJsonPortable(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${path} is a non-finite number; JSON drops it`);
      }
      return;
    case "object":
      break;
    default:
      throw new Error(
        `${path} is a ${typeof value}, which does not survive JSON ` +
          "serialization",
      );
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertJsonPortable(element, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `${path} is a non-plain object; JSON would flatten it lossily`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonPortable(entry, `${path}.${key}`);
  }
}
