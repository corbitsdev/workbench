// The granola-call workflow: the parent half of the Granola call-notes
// pipeline (CL-5998). Meant to be attached to a Routine on a recurring
// schedule (hourly or daily both work — see the README), it discovers
// recent Granola calls and starts one process-granola-call run per call
// that has no published call-notes artifact yet. Idempotent by design: a
// quiet run (nothing new since the last poll) starts nothing.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.
//
// Infrastructure gap (see README "Current limits"): fanning a parent run
// out into per-call child runs is Granola-specific machinery nowhere near
// ready in this host today — no shipped Interchange host resolves the
// `action` primitive `@intx/workflow` already declares (confirmed by
// `@corbits/heartbeat-workflow`'s own README). That gap is unrelated to
// tool access: CL-5999 closed the tool-pin gap this file used to
// document here (`@intx/agent`'s `defineAgent` still does not accept a
// `toolPackagePins` field — it is vendored, read-only source — so the
// agent below is built directly against `AgentDefinition`'s own type,
// which already carries the field). `@corbits/granola-tools` is pinned
// below; whether it *resolves* at deploy time still depends on an
// operator publishing it to a registry the host's tool-package resolver
// can reach (npm, or an Interchange package-registry asset — see
// `apps/hub/src/index.ts`'s `toolPackageRegistries` wiring). Until a
// deploy actually resolves the pin, this definition's system prompt
// still commits it to saying plainly that Granola is not connected
// rather than inventing call data, the same "no fallbacks" standard the
// rest of this repo holds.
//
// Status reporting (CL-6029): the spawn gap above blocks the pipeline's
// real work, not an honest account of a run that did nothing.
// `granola_call_report_status` (`./finalize-tool.ts`) persists a real,
// chip-visible Library artifact — what was examined, why nothing
// started, what to check next — every time a run starts no children,
// instead of a bare "Granola is not connected" line with nothing else.
// It is not approval-gated: a status report has nothing for a human to
// confirm, only what actually happened.

import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import type { CredentialBinding } from "@intx/types";

import { GRANOLA_CALL_REPORT_STATUS_TOOL_NAME } from "./finalize-tool";

export const GRANOLA_CALL_WORKFLOW_ID = "wf_granola_call";
export const GRANOLA_CALL_STEP_ID = "granola-call";

/** Recent calls examined per run when nothing else says otherwise. */
export const DEFAULT_CALL_LIMIT = 10;

export const GRANOLA_CALL_SYSTEM_PROMPT =
  "You run the Granola call-notes pipeline for this workspace, on a " +
  "recurring schedule. Each run: list recent Granola calls, and for " +
  "every call that has no published call-notes artifact yet, start one " +
  `process-granola-call run for it. Look at no more than ${DEFAULT_CALL_LIMIT} ` +
  "calls per run unless the trigger says otherwise. Never reprocess a " +
  "call that already has a published call-notes artifact — that check " +
  "is what keeps this idempotent. If a call's transcript is missing or " +
  "unreadable, skip only that call and continue with the rest of the " +
  "batch; never let one bad call stop the run. " +
  "If a run starts no process-granola-call children — no way to reach " +
  "Granola at all, or Granola is connected but there is nothing new to " +
  "process — never invent call counts, call names, or notes. Instead " +
  `call \`${GRANOLA_CALL_REPORT_STATUS_TOOL_NAME}\` exactly once with a ` +
  "plain-language reason grounded in what actually happened, how many " +
  "calls you actually examined (0 if you had no way to reach Granola at " +
  "all), and next steps a human can check, starting with the granola " +
  "connector's connection status for this workspace. This call requires " +
  "no approval; after it completes, give a one-sentence plain-text " +
  "summary of the same finding as your reply.";

/** Tool packages this definition pins (CL-5999); see the header comment. */
export const GRANOLA_CALL_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/granola-tools", version: "0.0.3" },
];

/**
 * Binds `@corbits/granola-tools`' declared "granola" handle to a
 * tenant-owned Granola credential (CL-6028). The launch resolves this
 * against `buildCredentialDelivery`, materializing a consumer-scoped
 * `credential:{id}` / `use` grant for the pinned package — see
 * `packages/granola-tools/src/tool.ts`'s header comment for the runtime
 * gap that still separates a binding resolved at launch and a credential
 * actually reachable by the tool at call time.
 */
export const GRANOLA_CALL_CREDENTIAL_BINDINGS: readonly CredentialBinding[] = [
  {
    package: "@corbits/granola-tools",
    handle: "granola",
    provider: "granola",
    locator: "tenant",
  },
];

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a Routine's scheduled trigger mail lands on — so
 * a definition built here is per-deployment by construction.
 */
export interface GranolaCallWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the granola-call definition. Exactly one step, matching the
 * shape every other definition in this repo commits to: tools and any
 * future spawn machinery arrive as packages on the deploy, never inlined
 * here, keeping the definition pure data.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call would then hang a run
 * forever.
 */
export function buildGranolaCallWorkflow(
  input: GranolaCallWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildGranolaCallWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildGranolaCallWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: GRANOLA_CALL_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    credentialBindings: GRANOLA_CALL_CREDENTIAL_BINDINGS,
    steps: {
      [GRANOLA_CALL_STEP_ID]: step({
        agent: {
          id: GRANOLA_CALL_STEP_ID,
          description:
            "Polls Granola for new calls and starts one call-notes run " +
            "per call that has not been processed yet",
          systemPrompt: GRANOLA_CALL_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: GRANOLA_CALL_TOOL_PACKAGE_PINS,
        } satisfies AgentDefinition,
        timeout: input.turnTimeoutMs,
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
 */
export function serializeGranolaCallWorkflow(
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

export {
  GRANOLA_CALL_REPORT_STATUS_TOOL,
  GRANOLA_CALL_REPORT_STATUS_TOOL_NAME,
  GRANOLA_CALL_REPORT_STATUS_DESCRIPTION,
  buildStatusArtifactPayload,
} from "./finalize-tool";
export type { ArtifactPayload, StatusReportArgs } from "./finalize-tool";
