// The `@corbits/workflow-authoring-tools` bundle: `workflow_author`,
// `workflow_republish`, `workflow_source_read`, and `workflow_deploy` — an
// agent's way to write a workflow code package into a `kind: "workflow"`
// hub asset, read it back, and deploy it through Interchange's native
// source pipeline. The first three carry no `approval: "ask"`: writing
// source is not a side effect (docs/workflow-model.md, "Authority
// boundaries"). `workflow_deploy` does — deploying is what makes a
// workflow selectable as a routine target, so a human sees the deploy
// intent and approves it before the tool call ever reaches the hub (CL-7362
// still owns showing the probed capability surface on that approval card;
// today's snapshot is the tool call's own arguments).
//
// A thrown error here is the honest result: `@intx/agent`'s tool runner
// converts a rejected `run` into `ToolResult { isError: true }` carrying
// the message, so the model sees exactly what the hub refused and why.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  authorWorkflow,
  deployWorkflow,
  previewDeployWorkflow,
  readWorkflowSource,
  republishWorkflow,
  type WorkflowAuthoringClientConfig,
} from "./client";

export const WORKFLOW_AUTHOR_TOOL = "workflow_author";
export const WORKFLOW_REPUBLISH_TOOL = "workflow_republish";
export const WORKFLOW_SOURCE_READ_TOOL = "workflow_source_read";
export const WORKFLOW_DEPLOY_PREVIEW_TOOL = "workflow_deploy_preview";
export const WORKFLOW_DEPLOY_TOOL = "workflow_deploy";

/** Env this bundle needs beyond `BaseEnv`: the hub origin under its own
 * key plus the run's bearer token and address, threaded by
 * `apps/sidecar/src/workflow-substrate-factory/step-env.ts` exactly the
 * way `@corbits/capability-tools`' `hubCapabilitiesUrl` is. */
export interface WorkflowAuthoringEnv extends BaseEnv {
  readonly hubWorkflowAuthoringUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const Files = type("Record<string, string>");

const AuthorInput = type({
  name: "string > 0",
  files: Files,
  "message?": "string > 0",
});

const RepublishInput = type({
  assetId: "string > 0",
  files: Files,
  "message?": "string > 0",
  "expectedHeadSha?": "string > 0",
});

const SourceReadInput = type({ assetId: "string > 0" });

const DeployPreviewInput = type({
  assetId: "string > 0",
  commitSha: "string > 0",
  entry: "string > 0",
});

const DeployInput = type({
  assetId: "string > 0",
  commitSha: "string > 0",
  entry: "string > 0",
  expectedWireHash: "string > 0",
  grants: "string[]",
});

const PACKAGE_SHAPE_DESCRIPTION =
  "The package is an ordinary code package: a top-level package.json " +
  'with name, version, "type": "module", and ' +
  '"interchange": { "workflow": "./workflow.ts" }; the entry module ' +
  "default-exports defineWorkflow({ ... }) imported from " +
  '"@intx/workflow"; plus any files the entry imports. File paths are ' +
  'repo-relative with "/" separators (no leading "/", no "..", no ' +
  ".git/); secret-like names (.env*, *.pem, *.key, id_rsa*, *.p12) are " +
  "refused, and never put credentials in source. ";

const FILES_PROPERTY = {
  type: "object",
  additionalProperties: { type: "string" },
  description:
    "Map of repo-relative file path to UTF-8 file contents, e.g. " +
    '{ "package.json": "...", "workflow.ts": "..." }.',
} as const;

function clientConfig(
  env: WorkflowAuthoringEnv,
): WorkflowAuthoringClientConfig {
  return {
    hubWorkflowAuthoringUrl: env.hubWorkflowAuthoringUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

function invalidInput(tool: string, errors: type.errors): Error {
  return new Error(`${tool} received invalid input: ${errors.summary}`);
}

function textResult(callId: string, content: string): ToolResult {
  return { callId, isError: false, content };
}

async function runAuthor(
  env: WorkflowAuthoringEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const input = AuthorInput(call.arguments);
  if (input instanceof type.errors) {
    throw invalidInput(WORKFLOW_AUTHOR_TOOL, input);
  }
  const summary = await authorWorkflow(clientConfig(env), input);
  return textResult(
    call.id,
    `Authored workflow "${summary.name}" as asset ${summary.assetId} at commit ${summary.commitSha}. ` +
      "It is source only until deployed.",
  );
}

async function runRepublish(
  env: WorkflowAuthoringEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const input = RepublishInput(call.arguments);
  if (input instanceof type.errors) {
    throw invalidInput(WORKFLOW_REPUBLISH_TOOL, input);
  }
  const summary = await republishWorkflow(clientConfig(env), input);
  return textResult(
    call.id,
    `Republished workflow "${summary.name}" (asset ${summary.assetId}) at commit ${summary.commitSha}. ` +
      "A deployed copy keeps running the previously deployed commit until redeployed.",
  );
}

async function runSourceRead(
  env: WorkflowAuthoringEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const input = SourceReadInput(call.arguments);
  if (input instanceof type.errors) {
    throw invalidInput(WORKFLOW_SOURCE_READ_TOOL, input);
  }
  const snapshot = await readWorkflowSource(clientConfig(env), input.assetId);
  return textResult(call.id, JSON.stringify(snapshot));
}

async function runDeployPreview(
  env: WorkflowAuthoringEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const input = DeployPreviewInput(call.arguments);
  if (input instanceof type.errors) {
    throw invalidInput(WORKFLOW_DEPLOY_PREVIEW_TOOL, input);
  }
  const result = await previewDeployWorkflow(clientConfig(env), input);
  return textResult(call.id, JSON.stringify(result));
}

async function runDeploy(
  env: WorkflowAuthoringEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const input = DeployInput(call.arguments);
  if (input instanceof type.errors) {
    throw invalidInput(WORKFLOW_DEPLOY_TOOL, input);
  }
  const result = await deployWorkflow(clientConfig(env), {
    assetId: input.assetId,
    commitSha: input.commitSha,
    entry: input.entry,
    expectedWireHash: input.expectedWireHash,
  });
  return textResult(
    call.id,
    `Deployed workflow asset ${result.definitionAssetId} as deployment ${result.deploymentId} (status: ${result.status}). ` +
      "It is now selectable as a routine target.",
  );
}

/**
 * The bundle id's middle segment is not the package name, unlike every
 * other `@corbits/*-tools` bundle: `<id>:<tool name>` is what goes on the
 * provider wire, `@`, `/`, `:` and `-` each encode to three characters
 * there (`@intx/inference`'s `encodeToolName`), and
 * `@corbits/workflow-authoring-tools/<anything>:workflow_source_read`
 * cannot fit OpenAI's 64-character cap. `defineTool` only requires the
 * `@scope/pkg/name` shape; `packages/tool-registry-publish`'s
 * tool-name-limits test is what this id satisfies.
 */
export const workflowAuthoringTools = defineTool<WorkflowAuthoringEnv>({
  id: "@corbits/workflow_authoring/wf",
  requires: ["hubWorkflowAuthoringUrl", "sidecarToken", "address"],
  definitions: [
    { name: WORKFLOW_AUTHOR_TOOL },
    { name: WORKFLOW_REPUBLISH_TOOL },
    { name: WORKFLOW_SOURCE_READ_TOOL },
    { name: WORKFLOW_DEPLOY_PREVIEW_TOOL },
    { name: WORKFLOW_DEPLOY_TOOL, approval: "ask" },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: WORKFLOW_AUTHOR_TOOL,
        description:
          "Write a new workflow code package into this workbench as a " +
          "workflow asset and commit it. " +
          PACKAGE_SHAPE_DESCRIPTION +
          "Returns the asset id and commit sha. This only stores source: " +
          "deploying the asset so it can run is a separate step that a " +
          "human approves. The name must be unique in the workbench; a " +
          "duplicate name is refused, so republish the existing asset " +
          "instead.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Lowercase-kebab asset name (letters, digits, hyphens), " +
                'e.g. "daily-digest".',
            },
            files: FILES_PROPERTY,
            message: {
              type: "string",
              description: "Optional commit message.",
            },
          },
          required: ["name", "files"],
        },
      },
      {
        name: WORKFLOW_REPUBLISH_TOOL,
        description:
          "Commit a new version of an existing workflow asset's source. " +
          "Send the whole package (package.json and the entry module " +
          "included): each file overwrites the same path, and a path you " +
          "omit keeps its committed content — this tool cannot delete " +
          "files. " +
          PACKAGE_SHAPE_DESCRIPTION +
          "Pass expectedHeadSha (the headSha from workflow_source_read) " +
          "so a concurrent change is refused instead of overwritten; on a " +
          "conflict, read the source again and retry. Returns the new " +
          "commit sha. Deploying the new commit is a separate, " +
          "human-approved step.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The workflow asset id to update.",
            },
            files: FILES_PROPERTY,
            message: {
              type: "string",
              description: "Optional commit message.",
            },
            expectedHeadSha: {
              type: "string",
              description:
                "The head commit sha you last read; the write is refused " +
                "if the asset has moved since.",
            },
          },
          required: ["assetId", "files"],
        },
      },
      {
        name: WORKFLOW_SOURCE_READ_TOOL,
        description:
          "Read a workflow asset's committed source: every file on its " +
          "main branch plus the head commit sha. Use it before " +
          "workflow_republish to see the current tree and to obtain " +
          "expectedHeadSha.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The workflow asset id to read.",
            },
          },
          required: ["assetId"],
        },
      },
      {
        name: WORKFLOW_DEPLOY_PREVIEW_TOOL,
        description:
          "Preview what deploying a workflow asset's committed source " +
          "would grant, WITHOUT deploying it: runs the same install + " +
          "probe as workflow_deploy but never freezes anything. Returns " +
          "the wire hash and the walked grant surface. Call this BEFORE " +
          "workflow_deploy and pass its wireHash as expectedWireHash and " +
          "its grants as grants on that call, so the human approving the " +
          "deploy sees exactly what will be granted.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The workflow asset id to preview a deploy of.",
            },
            commitSha: {
              type: "string",
              description:
                "The exact commit to preview — the commitSha from " +
                "workflow_author, workflow_republish, or " +
                "workflow_source_read's headSha.",
            },
            entry: {
              type: "string",
              description:
                'The interchange.workflow entry module path, e.g. "./workflow.ts".',
            },
          },
          required: ["assetId", "commitSha", "entry"],
        },
      },
      {
        name: WORKFLOW_DEPLOY_TOOL,
        description:
          "Deploy a workflow asset's committed source through " +
          "Interchange's native deploy pipeline (install, probe, capability " +
          "walk, gate, freeze), making it selectable as a routine target. " +
          "Call workflow_deploy_preview FIRST and pass its wireHash as " +
          "expectedWireHash and its grants as grants here — that is what " +
          "the human sees on the approval card before this call parks. " +
          "If the deploy re-probes to a different wire hash than " +
          "expectedWireHash (the source moved between preview and " +
          "approval), it fails closed even though the new definition is " +
          "frozen; re-preview and retry. Inference sources come from the " +
          "workbench's own catalog — never pass a model or credential.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The workflow asset id to deploy.",
            },
            commitSha: {
              type: "string",
              description:
                "The exact commit to deploy — the commitSha from " +
                "workflow_author, workflow_republish, or " +
                "workflow_source_read's headSha.",
            },
            entry: {
              type: "string",
              description:
                'The interchange.workflow entry module path, e.g. "./workflow.ts".',
            },
            expectedWireHash: {
              type: "string",
              description:
                "The wireHash returned by workflow_deploy_preview for this " +
                "same asset/commit/entry.",
            },
            grants: {
              type: "array",
              items: { type: "string" },
              description:
                "The grants returned by workflow_deploy_preview for this " +
                "same asset/commit/entry, so the approval card shows what " +
                "will be granted.",
            },
          },
          required: [
            "assetId",
            "commitSha",
            "entry",
            "expectedWireHash",
            "grants",
          ],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case WORKFLOW_AUTHOR_TOOL:
          return runAuthor(env, call);
        case WORKFLOW_REPUBLISH_TOOL:
          return runRepublish(env, call);
        case WORKFLOW_SOURCE_READ_TOOL:
          return runSourceRead(env, call);
        case WORKFLOW_DEPLOY_PREVIEW_TOOL:
          return runDeployPreview(env, call);
        case WORKFLOW_DEPLOY_TOOL:
          return runDeploy(env, call);
        default:
          return Promise.reject(
            new Error(
              `@corbits/workflow-authoring-tools: unknown tool "${call.name}"`,
            ),
          );
      }
    },
  }),
});
