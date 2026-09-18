// Builds and publishes Myra's deployable definition entirely over stock
// routes: ensure the `workflow`-kind asset exists, mint a short-lived push
// token, push the rendered source tree into the asset's git repo, revoke
// the token, and hand back the `WorkflowDeployInput` pinned to that commit.
import { ASSISTANT_SYSTEM_PROMPT } from "@corbits/myra/prompt";
import { ASSISTANT_TOOL_PACKAGE_PINS } from "@corbits/myra/tool-packages";
import { ASSISTANT_STEP_ID, ASSISTANT_WORKFLOW_ID } from "@corbits/myra/workflow-ids";
import { renderWorkflowSourceTree } from "@corbits/workflows/client";
import { type } from "arktype";

import { MYRA_SOURCE_CONFIG } from "./myra-source";
import type { WorkflowDeployInput } from "./needs-list";
import type { DeclaredSource } from "./onboarding/provider-connect-step";

export class MyraDeployError extends Error {}

const AssetCreatedShape = type({ id: "string" });
const AssetListShape = type({ id: "string", name: "string" }).array();
const GitTokenMintShape = type({ id: "string", secret: "string" });

const PUSH_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

async function readErrorBody(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = type({
    error: { code: "string", userMessage: "string", refId: "string" },
  })(body);
  return envelope instanceof type.errors ? `HTTP ${response.status}` : envelope.error.userMessage;
}

/** Idempotently ensures the `workflow` asset Myra's source is pushed
 * into: create it, or on 409 find the existing one by name. */
export async function ensureMyraSourceAsset(
  tenantId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const created = await fetchImpl(`/api/tenants/${encodeURIComponent(tenantId)}/assets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: MYRA_SOURCE_CONFIG.assetKind,
      name: MYRA_SOURCE_CONFIG.assetName,
      displayName: MYRA_SOURCE_CONFIG.displayName,
    }),
  });
  if (created.status === 201) {
    const parsed = AssetCreatedShape(await created.json());
    if (parsed instanceof type.errors) {
      throw new MyraDeployError(`Myra's source came back an unexpected shape: ${parsed.summary}`);
    }
    return parsed.id;
  }
  if (created.status !== 409) {
    throw new MyraDeployError(`preparing Myra's source failed: ${await readErrorBody(created)}`);
  }
  const listed = await fetchImpl(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets?kind=${MYRA_SOURCE_CONFIG.assetKind}&inherited=false`,
  );
  if (!listed.ok) {
    throw new MyraDeployError(
      `checking this workbench's setup failed: ${await readErrorBody(listed)}`,
    );
  }
  const parsed = AssetListShape(await listed.json());
  if (parsed instanceof type.errors) {
    throw new MyraDeployError(
      `this workbench's setup list came back an unexpected shape: ${parsed.summary}`,
    );
  }
  const existing = parsed.find((asset) => asset.name === MYRA_SOURCE_CONFIG.assetName);
  if (existing === undefined) {
    throw new MyraDeployError(
      "Myra's source reported a name conflict but is not listed on this workbench",
    );
  }
  return existing.id;
}

const ASSISTANT_TURN_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The exact `WorkflowDefinition` JSON `@corbits/myra`'s
 * `buildAssistantWorkflow` would produce for a single-step, mail-triggered,
 * unbounded-turn assistant — hand-built here rather than calling that
 * function, because `buildAssistantWorkflow` goes through `@intx/workflow`'s
 * `defineWorkflow`/`step`, which pull in `@intx/agent`'s Node-bound runtime
 * (file locking) that a browser bundle cannot resolve (confirmed by a failed
 * `apps/web` build importing `@corbits/myra` directly).
 * `apps/web/src/myra-deploy.test.ts` and `agents/myra`'s own
 * `validate-push.test.ts`-style round-trip both guard this shape against
 * drift from `defineWorkflow`'s own normalization
 * (`vendor/intx/workflow/src/definition/workflow.ts`'s `normalize`/
 * `applyDefaultInputStep`, and `primitives.ts`'s `step`): a single step with
 * no `after` gets `input: { from: "trigger.payload" }`; `triggers:
 * "unbounded"` (not the numeric default) gets `drainBehavior: "wait"`; a
 * bare `trigger` becomes a one-element `triggers` array.
 */
export function buildMyraDefinitionJson(
  triggerAddress: string,
  declaredSources: readonly DeclaredSource[],
): unknown {
  return {
    id: ASSISTANT_WORKFLOW_ID,
    triggers: [{ type: "mail", to: triggerAddress }],
    steps: {
      [ASSISTANT_STEP_ID]: {
        kind: "step",
        id: ASSISTANT_STEP_ID,
        agent: {
          id: ASSISTANT_STEP_ID,
          description:
            "A general-purpose assistant that answers questions, drafts " +
            "text, and reasons through problems for the team",
          systemPrompt: ASSISTANT_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          // The probe approves exactly these `(provider, model)` pairs, so
          // they must name what the deploy's offering chain resolves to.
          inference: { sources: declaredSources.map((source) => ({ ...source })) },
          toolPackagePins: ASSISTANT_TOOL_PACKAGE_PINS,
        },
        drainBehavior: "wait",
        timeout: ASSISTANT_TURN_TIMEOUT_MS,
        triggers: "unbounded",
        input: { from: "trigger.payload" },
      },
    },
    stepOrder: [ASSISTANT_STEP_ID],
  };
}

/** Mints a push-only token scoped to `main`, runs `push` with it, and
 * revokes the token afterwards whatever the push's outcome. */
async function withPushToken<T>(
  tenantId: string,
  assetId: string,
  fetchImpl: typeof fetch,
  push: (token: string) => Promise<T>,
): Promise<T> {
  const tokensPath = `/api/tenants/${encodeURIComponent(tenantId)}/git-tokens`;
  const minted = await fetchImpl(tokensPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "myra-deploy",
      resource: `asset:${assetId}`,
      refPattern: "refs/heads/main",
      // The ref advertisement before a push is a read, so a push-only
      // token is refused at info/refs.
      actions: ["can_read", "can_push"],
      expiresAt: new Date(Date.now() + PUSH_TOKEN_LIFETIME_MS).toISOString(),
    }),
  });
  if (!minted.ok) {
    throw new MyraDeployError(`minting a push token failed: ${await readErrorBody(minted)}`);
  }
  const token = GitTokenMintShape(await minted.json());
  if (token instanceof type.errors) {
    throw new MyraDeployError(`the push token came back an unexpected shape: ${token.summary}`);
  }
  try {
    return await push(token.secret);
  } finally {
    await fetchImpl(`${tokensPath}/${encodeURIComponent(token.id)}`, { method: "DELETE" });
  }
}

/** Renders Myra's built definition as a source tree and pushes it to the
 * asset's `main`. Returns the commit sha the deploy pins to. */
export async function pushMyraSource(
  tenantId: string,
  assetId: string,
  tenantDomain: string,
  declaredSources: readonly DeclaredSource[],
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const tree = renderWorkflowSourceTree({
    packageName: MYRA_SOURCE_CONFIG.packageName,
    workflowJson: JSON.stringify(
      buildMyraDefinitionJson(`assistant@${tenantDomain}`, declaredSources),
    ),
  });
  const url = new URL(
    `/api/tenants/${encodeURIComponent(tenantId)}/assets/${MYRA_SOURCE_CONFIG.assetKind}/${MYRA_SOURCE_CONFIG.assetName}.git`,
    globalThis.location.origin,
  ).toString();
  // Loaded on demand: the git client only runs during setup, so it stays
  // out of the main bundle.
  const { pushSourceTree } = await import("./git-push");
  return withPushToken(tenantId, assetId, fetchImpl, (token) =>
    pushSourceTree({ url, token, tree, message: "Publish Myra's definition" }),
  );
}

/** The pure mapping this module exists to get right: the operator's
 * offering pick plus the commit just pushed, turned into the exact
 * `WorkflowDeployInput` `convergeNeedsList` needs. */
export function buildMyraDeployInput(args: {
  assetId: string;
  commitSha: string;
  sourceOfferingIds: readonly string[];
  defaultSourceOfferingId: string;
}): WorkflowDeployInput {
  if (args.sourceOfferingIds.length === 0) {
    throw new MyraDeployError("at least one source offering id is required to start Myra");
  }
  if (!args.sourceOfferingIds.includes(args.defaultSourceOfferingId)) {
    throw new MyraDeployError(
      "the default source offering id must be one of the supplied source offering ids",
    );
  }
  return {
    source: {
      kind: "asset",
      assetId: args.assetId,
      package: { format: "source", commitSha: args.commitSha },
    },
    entry: MYRA_SOURCE_CONFIG.entryPath,
    sourceOfferingIds: [...args.sourceOfferingIds],
    defaultSourceOfferingId: args.defaultSourceOfferingId,
  };
}

/** Orchestrates the steps above and returns the `myraDeploy` input
 * ready to hand to `bootstrapClientSession`/`convergeNeedsList`. */
export async function deployMyraSource(
  args: {
    tenantId: string;
    tenantDomain: string;
    sourceOfferingIds: readonly string[];
    defaultSourceOfferingId: string;
    declaredSources: readonly DeclaredSource[];
  },
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowDeployInput> {
  const assetId = await ensureMyraSourceAsset(args.tenantId, fetchImpl);
  const commitSha = await pushMyraSource(
    args.tenantId,
    assetId,
    args.tenantDomain,
    args.declaredSources,
    fetchImpl,
  );
  return buildMyraDeployInput({
    assetId,
    commitSha,
    sourceOfferingIds: args.sourceOfferingIds,
    defaultSourceOfferingId: args.defaultSourceOfferingId,
  });
}
