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

function toolPackagePinsField(
  source: object,
  field: string,
): readonly { readonly name: string; readonly version: string }[] {
  if (!(field in source)) return [];
  const value = (source as Record<string, unknown>)[field];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (pin): pin is { name: string; version: string } =>
      pin !== null &&
      typeof pin === "object" &&
      typeof (pin as Record<string, unknown>).name === "string" &&
      typeof (pin as Record<string, unknown>).version === "string",
  );
}

/**
 * CL-7362: `workflow_deploy` (`@corbits/workflow-authoring-tools`) parks an
 * approval whose arguments carry the packageName/toolPackagePins a prior
 * `workflow_deploy_preview` call (a static read of the committed source)
 * reported, passed through. This renders that directly rather than
 * falling back to the tool's generic description, so the approval card
 * names the real package and tools instead of a bare asset id. It does
 * NOT show grants/capabilities: those are stamped by the native
 * install+probe+gate `workflow_deploy` itself runs, which has no
 * no-freeze preview yet (CL-7362).
 */
function workflowDeployHeadline(toolArguments: object): string | undefined {
  const commitSha = stringField(toolArguments, "commitSha");
  if (commitSha === undefined) return undefined;
  const packageName =
    stringField(toolArguments, "packageName") ??
    stringField(toolArguments, "assetId");
  if (packageName === undefined) return undefined;
  const sha7 = commitSha.slice(0, 7);
  const pins = toolPackagePinsField(toolArguments, "toolPackagePins");
  const toolsText =
    pins.length > 0
      ? pins.map((pin) => `${pin.name}@${pin.version}`).join(", ")
      : "none declared";
  return `Deploy workflow ${packageName} @ ${sha7} — tools: ${toolsText}`;
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
