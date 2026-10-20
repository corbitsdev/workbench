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
  return redactText(`Deploy workflow ${packageName} @ ${sha7} — tools: ${toolsText}`);
}

const TOOL_HEADLINE_RENDERERS: Readonly<
  Record<string, (toolArguments: object) => string | undefined>
> = {
  workflow_deploy: workflowDeployHeadline,
};

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
  return title === undefined ? headline : `${headline}: "${formatArgumentValue(title)}"`;
}

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
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") {
        return JSON.stringify(redactExtra(parsed as Record<string, unknown>));
      }
    } catch {
      // Non-JSON string falls through to plain-text redaction.
    }
    return redactText(value);
  }
  return JSON.stringify(redactExtra(value as Record<string, unknown>));
}

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
  const redacted = redactExtra(toolArguments as Record<string, unknown>);
  if (redacted === undefined) return undefined;
  const entries = Object.entries(redacted);
  if (entries.length === 0) return undefined;
  return truncate(
    entries.map(([key, value]) => `${key}: ${formatArgumentValue(value)}`).join(", "),
  );
}

export function argumentsSummaryFor(
  toolDefinition: unknown,
  toolArguments: unknown,
): string | undefined {
  if (typeof toolArguments !== "object" || toolArguments === null) return undefined;
  const toolName = toolNameFor(toolDefinition);
  const renderer = toolName !== undefined ? ARGUMENT_SUMMARY_RENDERERS[toolName] : undefined;
  return renderer?.(toolArguments) ?? genericArgumentsSummary(toolArguments);
}
