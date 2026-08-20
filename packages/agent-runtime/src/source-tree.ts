// Renders the source tree a code-sourced deploy actually deploys.
//
// Under the workflow.json retirement a deployment's definition is
// whatever its own pinned code closure evaluates to, and the approved
// wire hash covers every field that differs per run. So the per-run
// config cannot ride beside the bytes — it has to BE the bytes.
//
// The tree this renders is deliberately thin AND dependency-free: a
// `package.json` declaring only the entry, and an entry module that
// default-exports this run's evaluated definition as a JSON literal.
// The hub evaluates `buildAgentRuntimeWorkflow` here, at render time,
// rather than shipping a call to it: an asset tree is a standalone
// codebase, so a `workspace:*` dependency on `@corbits/agent-runtime`
// has no workspace to resolve against and the closure resolver rejects
// it outright. `@corbits/workflow-source` renders the tree itself —
// the same two files every other authoring path writes — which keeps
// the config-IS-the-bytes property the retirement requires:
// everything that varies per run is inside the hashed source, nothing
// rides beside it.
//
// A host commits the tree into a `workflow`-kind asset and deploys it
// with `source.kind: "asset"`, `package.format: "source"`, `commitSha` —
// the only source variant whose pin is cheap enough to mint per run
// (the registry and tarball variants would each need a publish).
import {
  renderWorkflowSourceTree,
  WORKFLOW_SOURCE_ENTRY,
} from "@corbits/workflow-source";
import { parseAgentRuntimeConfig, type AgentRuntimeConfig } from "./config";
import { buildAgentRuntimeWorkflow } from "./definition";

/** The entry path the rendered `package.json` declares and the sidecar evaluates. */
export const AGENT_RUNTIME_ENTRY_PATH = WORKFLOW_SOURCE_ENTRY;

export interface RenderAgentRuntimeSourceTreeInput {
  /**
   * The rendered package's own name. It never leaves the asset, so it
   * only has to be a valid package name and stable for a given run.
   */
  readonly packageName: string;
  /** The run's deploy-time config, rendered into the entry module. */
  readonly config: AgentRuntimeConfig;
}

/** File contents keyed by path relative to the tree root. */
export type AgentRuntimeSourceTree = Readonly<Record<string, string>>;

/**
 * Render the per-run workflow package. The config is validated before
 * it is written, so a config the run child would reject fails at the
 * deploying call site instead of inside the approval probe.
 */
export function renderAgentRuntimeSourceTree(
  input: RenderAgentRuntimeSourceTreeInput,
): AgentRuntimeSourceTree {
  const config = parseAgentRuntimeConfig(input.config);
  const definition = buildAgentRuntimeWorkflow(config);
  assertJsonPortable(definition, "definition");
  return renderWorkflowSourceTree({
    packageName: input.packageName,
    workflowJson: JSON.stringify(definition, null, 2),
  });
}

/**
 * A function reaching the rendered bytes would JSON-encode to `null` and
 * the sidecar would evaluate a silently different definition than the
 * hub validated. Every agent this builds declares `toolFactories: []`
 * (its tools come from `toolPackagePins`, resolved on the sidecar), so a
 * non-portable value here means the builder changed shape — fail at the
 * deploying call site rather than shipping the hole.
 */
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
        `${path} is a ${typeof value}, which does not survive JSON serialization`,
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
