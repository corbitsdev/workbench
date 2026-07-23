// Host-side action-handler registry for the native `action` primitive
// (WORKBENCH-OWNED, no upstream counterpart — the sidecar-local pairing to
// `@intx/workflow`'s fail-closed `createActionHandlerRegistry`).
//
// An `action` step carries no `AgentDefinition` — only a `handler` string
// ref, an optional `input` selector, and `effect.requires` capability
// names. The workflow runtime never resolves `handler` itself (mirroring
// how it never reads `agent.toolFactories`); resolving it to a concrete
// TypeScript function is entirely the host's job.
//
// `handler` is FLAT: it is the tool's canonical name (the same
// `<factoryId>:<name>` / bare short-name vocabulary `effect.requires` and
// `capabilityNames()`'s pinning walk already use), nothing more — no
// Workbench-specific prefix, no colon-delimited protocol requiring a
// parser, no embedded step identity.
//
// A handler takes an input, calls a tool, returns the output — that is ALL
// it does. It carries no invocation-time identity: no `stepId`, no
// `runId`, no `ctx.authzContext` read of any kind. Every action step's tool
// closure (pinned packages, tenant credentials, the on-disk deploy tree) is
// resolved EAGERLY, once, when this registry is constructed — the sidecar
// has the workflow definition in hand at that point (the SAME on-disk
// `workflow.json` `packages/workflow-host`'s `run-child.ts` reads moments
// later), and the hub stages a per-step deploy tree for EVERY `stepOrder`
// entry uniformly, action steps included
// (`interchange/packages/workflow-deploy/src/orchestrator.ts`'s
// `runMultiStepBranch` walks `deploy.workflow.stepOrder` and calls
// `launchSession`/`stageWorkflowStep` for every step regardless of
// primitive kind — `extractAgent` returning `null` for an action only
// skips the agent-specific `systemPrompt` fields, not the stage-tree call
// itself). So an action step's tool identity is resolvable the same way,
// at the same time, as a deterministic step's.
//
// Eager beats lazy here on purpose: a missing tool package or an
// unconfigured tenant credential must fail the moment the deployment is
// established, not silently no-op until the action first dispatches deep
// into an unattended overnight run (see `assertStepToolResolvable` in
// `step-tool-harness.ts`).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import type { ActionHandler, StepInvokeRequest } from "@intx/workflow";
import type { RepoId, RepoStore } from "@workbench/hub-sessions/substrate";
import type { AgentDefinition, BaseEnv } from "@intx/agent";
import { getLogger } from "@intx/log";

import {
  assertStepToolResolvable,
  runDeterministicToolStep,
  STEP_TOOL_CONTEXT_KEY,
  type StepToolContext,
} from "./step-tool-harness";

const logger = getLogger(["sidecar", "action-tool-handler"]);

const WORKFLOW_JSON_PATH = "workflow.json";

function sanitizeForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const WorkflowStepEntry = type({
  kind: "string",
  "handler?": "string",
});

const WorkflowDefinitionEnvelope = type({
  steps: "Record<string, unknown>",
});

/**
 * Read the deployed workflow's action steps straight off the SAME on-disk
 * `workflow.json` `packages/workflow-host`'s `child/run-child.ts`
 * (`loadWorkflowDefinition`) reads a moment after this registry is
 * constructed — the deploy orchestrator's `writeTree` has already
 * materialized it under the workflow-definition repo's working tree by the
 * time the substrate factory runs, so a flat `fs.readFile` here is exactly
 * as safe as that later read. Returns the FIRST stepId that declares each
 * distinct `handler` ref: two action steps sharing one tool name resolve
 * identically anyway (the deployment pins one uniform tool-package set for
 * every step — see `capabilityNames()`/`toolPackagesForCapabilities()` — and
 * per-step authorization is enforced separately, by the runtime's own
 * `EffectContext.perform`, not by which deploy tree loaded the runner).
 */
async function loadActionHandlerStepIds(
  substrate: RepoStore,
  workflowDefinitionRepoId: RepoId,
): Promise<Map<string, string>> {
  const dir = substrate.getRepoDir(workflowDefinitionRepoId);
  const workflowPath = path.join(dir, WORKFLOW_JSON_PATH);
  let raw: string;
  try {
    raw = await fs.promises.readFile(workflowPath, "utf8");
  } catch (cause) {
    throw new Error(
      `action-tool-handler: cannot read ${WORKFLOW_JSON_PATH} to resolve action handler refs for ${workflowDefinitionRepoId.kind}/${workflowDefinitionRepoId.id}`,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `action-tool-handler: ${WORKFLOW_JSON_PATH} for ${workflowDefinitionRepoId.kind}/${workflowDefinitionRepoId.id} is not valid JSON`,
      { cause },
    );
  }
  const envelope = WorkflowDefinitionEnvelope(parsed);
  if (envelope instanceof type.errors) {
    throw new Error(
      `action-tool-handler: ${WORKFLOW_JSON_PATH} for ${workflowDefinitionRepoId.kind}/${workflowDefinitionRepoId.id} failed validation: ${envelope.summary}`,
    );
  }

  const refs = new Map<string, string>();
  for (const [stepId, rawStep] of Object.entries(envelope.steps)) {
    const step = WorkflowStepEntry(rawStep);
    if (step instanceof type.errors) {
      throw new Error(
        `action-tool-handler: step ${JSON.stringify(stepId)} in ${WORKFLOW_JSON_PATH} failed validation: ${step.summary}`,
      );
    }
    if (step.kind !== "action") continue;
    if (step.handler === undefined) {
      throw new Error(
        `action-tool-handler: step ${JSON.stringify(stepId)} is kind "action" but declares no handler ref`,
      );
    }
    if (!refs.has(step.handler)) {
      refs.set(step.handler, stepId);
    }
  }
  return refs;
}

/** Placeholder `BaseEnv` slots `runDeterministicToolStep`'s tool-dispatch
 * path structurally requires but never reads for an action (no reactor, no
 * `createAgent`) — the same trivial shape `step-tool-deterministic.test.ts`
 * fixtures already use. `workdir` is real: tools that touch disk need it. */
function buildScratchEnv(
  workdir: string,
  stepToolContext: StepToolContext,
): Omit<BaseEnv, "authorize"> {
  return {
    sources: [],
    defaultSource: "",
    storage: undefined,
    audit: undefined,
    directors: {},
    workdir,
    [STEP_TOOL_CONTEXT_KEY]: stepToolContext,
  } as unknown as Omit<BaseEnv, "authorize">;
}

/**
 * Bind one action `handler` ref to its already-resolved `StepToolContext`.
 * Eagerly validates the tool resolves (fail-closed at establish, see
 * `assertStepToolResolvable`), then returns the pure `ActionHandler`: call
 * the tool, return the output. No `ctx.authzContext` read anywhere in the
 * returned function — every per-call `workdir` is a fresh, randomly keyed
 * scratch directory, reclaimed once the call settles.
 */
async function bindActionHandler(args: {
  dataDir: string;
  toolName: string;
  stepToolContext: StepToolContext;
}): Promise<ActionHandler> {
  const { dataDir, toolName, stepToolContext } = args;

  const preflightDir = path.join(
    dataDir,
    "workflow-action-scratch",
    "preflight",
    sanitizeForPath(toolName),
    crypto.randomUUID(),
  );
  const preflightWorkdir = path.join(preflightDir, "workspace");
  await fs.promises.mkdir(preflightWorkdir, { recursive: true });
  try {
    await assertStepToolResolvable({
      env: buildScratchEnv(preflightWorkdir, stepToolContext),
      toolName,
    });
  } finally {
    await fs.promises
      .rm(preflightDir, { recursive: true, force: true })
      .catch((cause: unknown) => {
        logger.warn(
          "action-tool-handler: failed to reclaim preflight scratch dir {dir} for {tool}: {msg}",
          {
            dir: preflightDir,
            tool: toolName,
            msg: cause instanceof Error ? cause.message : String(cause),
          },
        );
      });
  }

  return async (input, ctx, signal): Promise<unknown> => {
    const scratchDir = path.join(
      dataDir,
      "workflow-action-scratch",
      sanitizeForPath(toolName),
      crypto.randomUUID(),
    );
    const workdir = path.join(scratchDir, "workspace");
    await fs.promises.mkdir(workdir, { recursive: true });

    try {
      // Route through the action's capability- and ledger-checked
      // `EffectContext` rather than calling `runDeterministicToolStep`
      // directly: `ctx.perform` refuses any `capability` outside the
      // action's declared `effect.requires` set (authz floor) and dedupes
      // against the effect ledger on a crash re-run (exactly-once).
      return await ctx.perform({
        effectId: "tool-call",
        capability: toolName,
        run: async () => {
          const result = await runDeterministicToolStep({
            env: buildScratchEnv(workdir, stepToolContext),
            toolName,
            input,
            signal,
          });
          return result.output;
        },
      });
    } finally {
      await fs.promises
        .rm(scratchDir, { recursive: true, force: true })
        .catch((cause: unknown) => {
          logger.warn(
            "action-tool-handler: failed to reclaim scratch dir {dir} for {tool}: {msg}",
            {
              dir: scratchDir,
              tool: toolName,
              msg: cause instanceof Error ? cause.message : String(cause),
            },
          );
        });
    }
  };
}

/**
 * Build the `(ref) => ActionHandler` registry the sidecar threads into
 * `RunWorkflowChildBindings.resolveActionHandler`. Every action step's tool
 * closure is resolved EAGERLY, before this function returns: the workflow
 * definition is read once to find every `kind: "action"` step and its
 * `handler` ref, `resolveStepToolContext` resolves each ref's `StepToolContext`
 * (the same per-step resolver `createSidecarStepBuildEnv` uses for
 * deterministic/inference steps), and `bindActionHandler` preflights + binds
 * the pure handler. A ref with no action step declaring it (never a valid
 * production shape — the walk enumerates the same `handler` strings that
 * appear in the definition) throws when looked up.
 *
 * `resolveStepToolContext` is only ever handed a synthetic
 * `authzContext: { stepId }` here — there is no run yet at establish time,
 * so `workflowRunId` is never populated on the resolved `StepToolContext`.
 * That only affects run-creator-member OAuth scoping on tool-credential
 * fetch (`StepToolContext.workflowRunId`, an optional field); tenant-level
 * tool credentials resolve identically with or without it.
 */
export async function createActionToolHandlerRegistry(args: {
  dataDir: string;
  substrate: RepoStore;
  workflowDefinitionRepoId: RepoId;
  resolveStepToolContext: (req: StepInvokeRequest) => Promise<StepToolContext>;
}): Promise<(ref: string) => ActionHandler> {
  const actionRefs = await loadActionHandlerStepIds(
    args.substrate,
    args.workflowDefinitionRepoId,
  );

  const handlers = new Map<string, ActionHandler>();
  for (const [toolName, stepId] of actionRefs) {
    const stepToolContext = await args.resolveStepToolContext({
      agent: {} as AgentDefinition<BaseEnv>,
      input: undefined,
      authzContext: { stepId },
      signal: new AbortController().signal,
    });
    handlers.set(
      toolName,
      await bindActionHandler({
        dataDir: args.dataDir,
        toolName,
        stepToolContext,
      }),
    );
  }

  return (ref: string): ActionHandler => {
    const handler = handlers.get(ref);
    if (handler === undefined) {
      throw new Error(
        `action handler for ${JSON.stringify(ref)}: no action step in the workflow definition declares this handler ref`,
      );
    }
    return handler;
  };
}
