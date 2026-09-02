// The one display concern this package owns: the human-readable line an
// approval is described by. Pure string work over the tool snapshot an
// approval already carries, with no database or server dependency, so the
// browser can compose the same headline the hub-side tools do — hence its
// own module and `./headline` export rather than living beside the
// grant-allowance gate.

function stringField(source: object, field: string): string | undefined {
  if (!(field in source)) return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function stringArrayField(
  source: object,
  field: string,
): readonly string[] | undefined {
  if (!(field in source)) return undefined;
  const value = (source as Record<string, unknown>)[field];
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

/**
 * CL-7362: `workflow_deploy` (`@corbits/workflow-authoring-tools`) parks an
 * approval whose arguments carry the exact grant surface the human is
 * being asked to approve (`workflow_deploy_preview`'s output, passed
 * through). This renders that surface directly rather than falling back
 * to the tool's generic description, so the approval card reads as "what
 * will this actually grant" instead of "a tool wants to run".
 */
function workflowDeployHeadline(toolArguments: object): string | undefined {
  const assetId = stringField(toolArguments, "assetId");
  const commitSha = stringField(toolArguments, "commitSha");
  if (assetId === undefined || commitSha === undefined) return undefined;
  const sha7 = commitSha.slice(0, 7);
  const grants = stringArrayField(toolArguments, "grants") ?? [];
  const grantsText = grants.length > 0 ? grants.join(", ") : "no grants";
  return `Deploy workflow ${assetId} @ ${sha7} — grants: ${grantsText}`;
}

/**
 * Builds the headline for an approval. Prefers the tool's own
 * `description` — written by the tool's author to be human-readable —
 * over its bare `name`, which is a machine identifier. When the live
 * call's arguments carry a `title` (a tool author's own convention for
 * per-invocation context, e.g. "finalize this piece of collateral titled
 * X"), it is appended so the headline reflects what THIS approval is
 * actually about, not just which tool is asking.
 */
export function headlineFor(
  toolDefinition: unknown,
  toolArguments: unknown,
): string {
  const toolName =
    typeof toolDefinition === "object" && toolDefinition !== null
      ? stringField(toolDefinition, "name")
      : undefined;
  if (
    toolName === "workflow_deploy" &&
    typeof toolArguments === "object" &&
    toolArguments !== null
  ) {
    const deployHeadline = workflowDeployHeadline(toolArguments);
    if (deployHeadline !== undefined) return deployHeadline;
  }

  const base =
    typeof toolDefinition === "object" && toolDefinition !== null
      ? (stringField(toolDefinition, "description") ??
        stringField(toolDefinition, "name"))
      : undefined;
  const headline = base ?? "Run a tool";
  const title =
    typeof toolArguments === "object" && toolArguments !== null
      ? stringField(toolArguments, "title")
      : undefined;
  return title === undefined ? headline : `${headline}: "${title}"`;
}
