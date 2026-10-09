// The human-readable line an approval is described by. Pure string work, no
// database dependency, so the browser can compose the same headline the
// hub-side tools do.
import { redactExtra, redactText } from "@corbits/error-sink";

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
  // The package name, commit/sha, and any pin name/version are free-form caller
  // input a secret could be smuggled into; redact the assembled line the same
  // way write_file's content preview is, so a secret-shaped package or pin
  // never reaches the headline.
  return redactText(`Deploy workflow ${packageName} @ ${sha7} — tools: ${toolsText}`);
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
  // The title is a generic free-form field a caller can stuff a secret into;
  // redact it the same way generic arguments are, so a JSON string smuggled in
  // the title goes through the same structural (key-named) redaction as
  // `formatArgumentValue`, not just the flat assignment/keyword pass.
  return title === undefined ? headline : `${headline}: "${formatArgumentValue(title)}"`;
}

/** The bare tool name off a toolDefinition snapshot, for a row that wants to
 * name the call apart from its (possibly generic) description. */
export function toolNameFor(toolDefinition: unknown): string | undefined {
  return typeof toolDefinition === "object" && toolDefinition !== null
    ? stringField(toolDefinition, "name")
    : undefined;
}

const ARGUMENT_PREVIEW_LIMIT = 120;

function truncate(text: string, limit = ARGUMENT_PREVIEW_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function formatArgumentValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  // Default: redact a string (or a stringified object/array) structurally when
  // it parses as JSON, so key-named secrets (`password`, `token`, ...) and
  // nested JSON are caught; fall back to plain redactText for non-JSON strings.
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") {
        return JSON.stringify(redactExtra(parsed as Record<string, unknown>));
      }
    } catch {
      // not JSON; redact as a plain string below
    }
    return redactText(value);
  }
  // A live object/array argument: redact it structurally, then serialize.
  const redacted = redactExtra(value as Record<string, unknown>);
  return JSON.stringify(redacted);
}

// `write_file`'s call is read as its target path plus a preview of what it
// writes there -- the two facts a person approving it actually needs, not
// the raw argument bag.
function writeFileArgumentsSummary(toolArguments: object): string | undefined {
  const path = stringField(toolArguments, "path");
  if (path === undefined) return undefined;
  const content = (toolArguments as Record<string, unknown>).content;
  const preview = typeof content === "string" ? `: "${truncate(redactText(content))}"` : "";
  return `${path}${preview}`;
}

const ARGUMENT_SUMMARY_RENDERERS: Readonly<
  Record<string, (toolArguments: object) => string | undefined>
> = {
  write_file: writeFileArgumentsSummary,
};

function genericArgumentsSummary(toolArguments: object): string | undefined {
  // Redact the whole bag structurally first: this collapses key-named secrets
  // (`password`, `token`, `apiKey`, ...) regardless of their value's shape and
  // recurses into nested objects/strings, which the per-value format path
  // below then renders (already-safe values pass through unchanged).
  const redacted = redactExtra(toolArguments as Record<string, unknown>);
  if (redacted === undefined) return undefined;
  const entries = Object.entries(redacted);
  if (entries.length === 0) return undefined;
  return truncate(
    entries.map(([key, value]) => `${key}: ${formatArgumentValue(value)}`).join(", "),
  );
}

/** A compact, human-scannable rendering of a call's arguments -- a
 * registered per-tool renderer wins when it can (e.g. `write_file`'s path +
 * content preview), else a truncated `key: value` list. `undefined` when
 * there is nothing to show, so a caller can render "tool name only". */
export function argumentsSummaryFor(
  toolDefinition: unknown,
  toolArguments: unknown,
): string | undefined {
  if (typeof toolArguments !== "object" || toolArguments === null) return undefined;
  const toolName = toolNameFor(toolDefinition);
  const renderer = toolName !== undefined ? ARGUMENT_SUMMARY_RENDERERS[toolName] : undefined;
  return renderer?.(toolArguments) ?? genericArgumentsSummary(toolArguments);
}
