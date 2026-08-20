// Renders the source tree a code-sourced deploy actually deploys.
//
// Under the workflow.json retirement a deployment's definition is
// whatever its own pinned code closure evaluates to, and the approved
// wire hash covers every field that differs per run. So the per-run
// config cannot ride beside the bytes — it has to BE the bytes.
//
// The tree this renders is deliberately thin: a `package.json` and a
// four-line entry module that pins `@corbits/agent-runtime` and calls
// `buildAgentRuntimeWorkflow` with the run's config as a literal. All
// the behaviour stays in this one versioned package, reviewed and
// upgraded in one place; what varies per run is a JSON literal. A host
// commits the tree into a `workflow`-kind asset and deploys it with
// `source.kind: "asset"`, `package.format: "source"`, `commitSha` — the
// only source variant whose pin is cheap enough to mint per run (the
// registry and tarball variants would each need a publish).
import { parseAgentRuntimeConfig, type AgentRuntimeConfig } from "./config";
import { AGENT_RUNTIME_PACKAGE_NAME } from "./pin";

/** The entry path the rendered `package.json` declares and the sidecar evaluates. */
export const AGENT_RUNTIME_ENTRY_PATH = "./workflow.js";

export interface RenderAgentRuntimeSourceTreeInput {
  /**
   * The rendered package's own name. It never leaves the asset, so it
   * only has to be a valid package name and stable for a given run.
   */
  readonly packageName: string;
  /** The `@corbits/agent-runtime` range the rendered package depends on. */
  readonly runtimeVersion: string;
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
  const packageJson = {
    name: input.packageName,
    version: "0.0.0",
    private: true,
    type: "module",
    interchange: { workflow: AGENT_RUNTIME_ENTRY_PATH },
    dependencies: { [AGENT_RUNTIME_PACKAGE_NAME]: input.runtimeVersion },
  };
  const entry = [
    `import { buildAgentRuntimeWorkflow } from ${JSON.stringify(AGENT_RUNTIME_PACKAGE_NAME)};`,
    "",
    `export default buildAgentRuntimeWorkflow(${JSON.stringify(config, null, 2)});`,
    "",
  ].join("\n");

  return {
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "workflow.js": entry,
  };
}
