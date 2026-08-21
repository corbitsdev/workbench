// The `@corbits/workflow-authoring-tools` bundle: `author_workflow`
// (create-or-update a workflow codebase) and `deploy_workflow` (deploy an
// authored asset through the existing source-based deploy route) — an
// agent's own way to build a workflow as code and ship it, without a UI
// builder.
//
// `author_workflow` carries no `approval` key: writing source into the
// tenant's own git-backed asset store has no effect outside that store —
// same reasoning `@corbits/routines-tools`' `routine_create` documents for
// why it needs no approval. `deploy_workflow` DOES declare `approval:
// "ask"`: deploying starts the workflow running for real, taking whatever
// external action its own already-approved capabilities allow, so the
// reactor suspends it as a pending approval and renders it in-chat before
// this bundle's `run` ever executes — the same external-side-effect gate
// `routine_run_now` sits behind.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  authorWorkflow,
  deployAuthoredWorkflow,
  republishWorkflow,
  DeployWorkflowError,
  WorkflowAuthoringError,
  type WorkflowAuthoringToolClientConfig,
} from "./client";

export const AUTHOR_WORKFLOW_TOOL = "author_workflow";
export const DEPLOY_WORKFLOW_TOOL = "deploy_workflow";

export interface WorkflowAuthoringEnv extends BaseEnv {
  readonly hubWorkflowAuthoringUrl: string;
  readonly hubWorkflowsUrl: string;
  readonly tenantId: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const FilesInput = type("Record<string, string>");

const AuthorWorkflowInput = type({
  name: "string > 0",
  files: FilesInput,
  "assetId?": "string > 0",
  "message?": "string > 0",
});
type AuthorWorkflowInput = typeof AuthorWorkflowInput.infer;

const DeployWorkflowInput = type({
  assetId: "string > 0",
  entry: "string > 0",
  sources: type("Record<string, unknown>").array(),
  defaultSource: "string > 0",
  "pin?": "string > 0",
});
type DeployWorkflowInput = typeof DeployWorkflowInput.infer;

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(
  env: WorkflowAuthoringEnv,
): WorkflowAuthoringToolClientConfig {
  return {
    hubWorkflowAuthoringUrl: env.hubWorkflowAuthoringUrl,
    hubWorkflowsUrl: env.hubWorkflowsUrl,
    tenantId: env.tenantId,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

async function runAuthorWorkflow(
  env: WorkflowAuthoringEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = AuthorWorkflowInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`author_workflow received invalid input: ${parsed.summary}`),
    );
  }

  try {
    const summary =
      parsed.assetId !== undefined
        ? await republishWorkflow(clientConfig(env), {
            assetId: parsed.assetId,
            files: parsed.files,
            ...(parsed.message !== undefined
              ? { message: parsed.message }
              : {}),
          })
        : await authorWorkflow(clientConfig(env), {
            name: parsed.name,
            files: parsed.files,
            ...(parsed.message !== undefined
              ? { message: parsed.message }
              : {}),
          });
    return {
      callId: call.id,
      isError: false,
      content: `Authored "${summary.name}" (asset id: ${summary.assetId}, commit ${summary.commitSha}). Use this asset id to deploy_workflow.`,
    };
  } catch (err) {
    if (err instanceof WorkflowAuthoringError) {
      return errorResult(call.id, err);
    }
    return errorResult(call.id, err);
  }
}

async function runDeployWorkflow(
  env: WorkflowAuthoringEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = DeployWorkflowInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`deploy_workflow received invalid input: ${parsed.summary}`),
    );
  }

  try {
    const deployment = await deployAuthoredWorkflow(clientConfig(env), parsed);
    return {
      callId: call.id,
      isError: false,
      content: `Deployed (deployment id: ${deployment.id}, status: ${deployment.status}).`,
    };
  } catch (err) {
    if (err instanceof DeployWorkflowError) {
      return errorResult(call.id, err);
    }
    return errorResult(call.id, err);
  }
}

/**
 * The `@corbits/workflow-authoring-tools` bundle factory: `author_workflow`
 * (create or, given `assetId`, republish a workflow codebase — free, no
 * approval) and `deploy_workflow` (deploy an authored asset through
 * `@intx/hub-api`'s existing source-based deploy route — a human must
 * approve, since this starts the workflow running for real).
 */
export const workflowAuthoringTools = defineTool<WorkflowAuthoringEnv>({
  id: "@corbits/workflow-authoring-tools/workflow-authoring",
  requires: [
    "hubWorkflowAuthoringUrl",
    "hubWorkflowsUrl",
    "tenantId",
    "sidecarToken",
    "address",
  ],
  definitions: [
    { name: AUTHOR_WORKFLOW_TOOL },
    { name: DEPLOY_WORKFLOW_TOOL, approval: "ask" },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: AUTHOR_WORKFLOW_TOOL,
        description:
          "Publish a workflow codebase — a package.json declaring an " +
          '"interchange.workflow" entry plus its source files — as a ' +
          "workflow-kind asset in this workbench. Pass an existing " +
          "assetId to republish (a new commit on that same asset) " +
          "instead of creating a new one.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "The new workflow asset's name (lowercase-kebab). " +
                "Ignored when assetId is given.",
            },
            files: {
              type: "object",
              description:
                'Repo-relative path -> file contents, e.g. { "package.json": "...", "index.ts": "..." }.',
              additionalProperties: { type: "string" },
            },
            assetId: {
              type: "string",
              description:
                "An existing workflow asset id to republish instead of " +
                "creating a new one.",
            },
            message: {
              type: "string",
              description: "Commit message for this publish.",
            },
          },
          required: ["name", "files"],
        },
      },
      {
        name: DEPLOY_WORKFLOW_TOOL,
        description:
          "Deploy a previously authored workflow asset. Installs, " +
          "probes, gates, and freezes the definition, then deploys it. " +
          "A human must approve before it runs.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description:
                "The workflow-kind asset id returned by author_workflow.",
            },
            entry: {
              type: "string",
              description:
                'The package-relative "interchange.workflow" entry module the sidecar evaluates.',
            },
            sources: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description:
                "The inference-source chain the workflow's per-step agents launch against.",
            },
            defaultSource: {
              type: "string",
              description: "Which of sources is the default.",
            },
            pin: {
              type: "string",
              description: "Optional package version pin for the source.",
            },
          },
          required: ["assetId", "entry", "sources", "defaultSource"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case AUTHOR_WORKFLOW_TOOL:
          return runAuthorWorkflow(env, call);
        case DEPLOY_WORKFLOW_TOOL:
          return runDeployWorkflow(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(
                `@corbits/workflow-authoring-tools: unknown tool "${call.name}"`,
              ),
            ),
          );
      }
    },
  }),
});
