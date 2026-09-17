// The credential-expiry workflow (CL-8181): on a schedule, check this
// tenant's credentials and mail a reconnect notice for each one that is
// active but past its own `expiresAt`. Replaces the hub-owned periodic
// loop `apps/hub/src/credential-expiry-sweep.ts` — that loop's own
// decision logic now lives in `./decide.ts` (moved rather than
// reimplemented; it needs no DB and no mail infrastructure to stay
// correct), and this definition is deployed like any other scheduled
// Routine instead of running inside the hub process for every tenant at
// once.
//
// Scope narrows on the port: the old sweep also refreshed
// `mcp:<slug>` OAuth tokens in place before ever mailing anyone
// (CL-6207) — that native-refresh path stays a hub concern (it mutates
// a stored credential's secret directly, which no stock tenant route
// exposes to a workflow run) and is not carried over here. This
// workflow only reads and reports, exactly as CL-8181 scopes it.
//
// Zero DB, one HTTP read: `credential_expiry_check` (`./tool.ts`) reads
// the stock `GET /api/tenants/:tenantId/credentials` (paired with
// `/providers` for display names) with the run's own bearer, then
// `findDueCredentialExpiries` decides which are due. The step's reply
// is the reconnect notice itself, delivered as mail by the host the
// same way `@corbits/heartbeat-workflow` and
// `@corbits/workbench-digest-workflow` deliver theirs — no separate
// mail-send tool exists in this repo yet.

import { defineAgent } from "@intx/agent";
import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";

import { CREDENTIAL_EXPIRY_CHECK_TOOL_NAME } from "./tool";

export const CREDENTIAL_EXPIRY_WORKFLOW_ID = "wf_credential_expiry";
export const CREDENTIAL_EXPIRY_STEP_ID = "credential-expiry-check";

/** Daily at 08:00 UTC — ahead of `workbench-digest`'s 09:00 slot, so a
 * reconnect notice for the day lands before the day's own digest. */
export const CREDENTIAL_EXPIRY_SCHEDULE_CRON = "0 8 * * *";

export const CREDENTIAL_EXPIRY_SYSTEM_PROMPT = [
  "You are a scheduled credential-expiry check for this workbench's " +
    "tenant. Nobody is watching this run happen — write for the tenant " +
    "owner reading it later, cold.",
  `Call \`${CREDENTIAL_EXPIRY_CHECK_TOOL_NAME}\` exactly once. It returns a \`due\` list of credentials that are active but past their own expiry.`,
  "If `due` is empty, reply with exactly one plain sentence saying every " +
    "connected credential is current — no other text.",
  "If `due` is non-empty, reply with a short reconnect notice: one " +
    "opening sentence, then one bullet per due credential naming its " +
    "`name` (or `providerLabel` if `name` is empty) and the `expiresAt` " +
    "instant it passed, and close with one sentence asking the reader to " +
    "reconnect it from the workbench's Plugins settings. Never invent a " +
    "credential the tool did not return, and never omit one it did.",
].join("\n\n");

/**
 * Everything the definition needs that is per-deployment data. The
 * schedule trigger is fixed on the definition; inference and the
 * per-turn timeout are resolved at deploy time.
 */
export interface CredentialExpiryWorkflowInput {
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the credential-expiry definition. Exactly one step, matching
 * the shape every other definition in this repo commits to. Tools are
 * never inlined on the serialized definition — `toolFactories` stays
 * empty here, same as every other package in `workflows/*`, since a
 * `ToolFactory` is a function and cannot survive the workflow asset's
 * JSON round trip; the deploy resolves this package's own exported
 * `CREDENTIAL_EXPIRY_CHECK_TOOL` the same way it resolves any other
 * pinned tool package.
 */
export function buildCredentialExpiryWorkflow(
  input: CredentialExpiryWorkflowInput,
): WorkflowDefinition {
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildCredentialExpiryWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: CREDENTIAL_EXPIRY_WORKFLOW_ID,
    trigger: { type: "schedule", cron: CREDENTIAL_EXPIRY_SCHEDULE_CRON },
    steps: {
      [CREDENTIAL_EXPIRY_STEP_ID]: step({
        agent: defineAgent({
          id: CREDENTIAL_EXPIRY_STEP_ID,
          description:
            "Checks this tenant's credentials for ones past their own " +
            "expiry and mails a reconnect notice for each",
          systemPrompt: CREDENTIAL_EXPIRY_SYSTEM_PROMPT,
          tools: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
        }) satisfies AgentDefinition,
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
export function serializeCredentialExpiryWorkflow(definition: WorkflowDefinition): string {
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
        `${path} is a ${typeof value}, which does not survive JSON ` + "serialization",
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
    throw new Error(`${path} is a non-plain object; JSON would flatten it lossily`);
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonPortable(entry, `${path}.${key}`);
  }
}

export {
  CREDENTIAL_EXPIRY_CHECK_TOOL,
  CREDENTIAL_EXPIRY_CHECK_TOOL_NAME,
  CREDENTIAL_EXPIRY_CHECK_DESCRIPTION,
} from "./tool";
export type { WorkflowCredentialExpiryEnv } from "./tool";
export { findDueCredentialExpiries } from "./decide";
export type { DueCredentialExpiry, ExpiringCredential } from "./decide";
