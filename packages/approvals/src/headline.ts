// The human-readable line an approval is described by. Pure string work, no
// database dependency, so the browser can compose the same headline the
// hub-side tools do.

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

/** Renders the packageName/toolPackagePins a prior `wf_deploy_preview` call
 * reported, so the card names the real package instead of a bare asset id.
 * Does not show grants/capabilities: those have no preview yet. */
function workflowDeployHeadline(toolArguments: object): string | undefined {
  const commitSha = stringField(toolArguments, "commitSha");
  if (commitSha === undefined) return undefined;
  const packageName =
    stringField(toolArguments, "packageName") ?? stringField(toolArguments, "assetId");
  if (packageName === undefined) return undefined;
  const sha7 = commitSha.slice(0, 7);
  const pins = toolPackagePinsField(toolArguments, "toolPackagePins");
  const toolsText =
    pins.length > 0 ? pins.map((pin) => `${pin.name}@${pin.version}`).join(", ") : "none declared";
  return `Deploy workflow ${packageName} @ ${sha7} — tools: ${toolsText}`;
}

/** Per-tool headline renderers, keyed by tool name — registering here avoids
 * another `if (toolName === ...)` branch in `headlineFor`. */
const TOOL_HEADLINE_RENDERERS: Readonly<
  Record<string, (toolArguments: object) => string | undefined>
> = {
  workflow_deploy: workflowDeployHeadline,
};

/** Builds the headline for an approval: a registered per-tool renderer wins
 * when it can, else the tool's `description` (falling back to its bare
 * `name`), with any call-supplied `title` appended. */
export function headlineFor(toolDefinition: unknown, toolArguments: unknown): string {
  const toolName =
    typeof toolDefinition === "object" && toolDefinition !== null
      ? stringField(toolDefinition, "name")
      : undefined;
  const renderer = toolName !== undefined ? TOOL_HEADLINE_RENDERERS[toolName] : undefined;
  if (renderer !== undefined && typeof toolArguments === "object" && toolArguments !== null) {
    const rendered = renderer(toolArguments);
    if (rendered !== undefined) return rendered;
  }

  const base =
    typeof toolDefinition === "object" && toolDefinition !== null
      ? (stringField(toolDefinition, "description") ?? stringField(toolDefinition, "name"))
      : undefined;
  const headline = base ?? "Run a tool";
  const title =
    typeof toolArguments === "object" && toolArguments !== null
      ? stringField(toolArguments, "title")
      : undefined;
  return title === undefined ? headline : `${headline}: "${title}"`;
}
