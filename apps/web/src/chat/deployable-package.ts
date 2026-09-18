// Either mail attachments, or — since `@intx/tools-mail`'s `mail_send` has
// no attachments parameter — two labelled fenced code blocks in the body.

import { type } from "arktype";
import { reportError } from "@corbits/error-sink";

import type { MailAttachment } from "./threads-api";

const PackageManifest = type({
  "name?": "string",
});

const AgentDefinitionShape = type({
  "name?": "string",
  systemPrompt: "string",
  "description?": "string",
  "schedule?": "string",
});

/** A cron string this pipeline accepts: exactly five whitespace-separated
 * fields. No third-party parser — the fields are validated for shape only,
 * `@corbits/cron`'s `isValidCronExpression` is the semantic check. */
export function isFiveFieldCron(schedule: string): boolean {
  return schedule.trim().split(/\s+/).length === 5;
}

export interface DeployablePackage {
  readonly name: string;
  readonly systemPrompt: string;
  readonly description?: string;
  readonly schedule?: string;
}

export const PACKAGE_MANIFEST_NAME = "package.json";
export const AGENT_DEFINITION_NAME = "definition.json";

// `null` when the message isn't a package attempt at all.
export type PackageOutcome = DeployablePackage | { readonly reason: string } | null;

export function isPackageRejection(
  outcome: PackageOutcome,
): outcome is { readonly reason: string } {
  return outcome !== null && "reason" in outcome;
}

/** The plain-words reason a definition.json's arktype error names, e.g.
 * "definition.json is missing systemPrompt" or "definition.json's
 * schedule must be a string". Field name comes from the error's path. */
function definitionRejectionReason(errors: type.errors): string {
  const first = errors[0];
  const field = first === undefined ? "value" : String(first.path.at(-1) ?? "value");
  if (first?.code === "required") return `definition.json is missing ${field}`;
  return `definition.json's ${field} ${first?.problem ?? "is invalid"}`;
}

/** Parses the two contract files' text into a package outcome. Returns
 * `null` only when called on files that were never actually found — the
 * caller decides that; this always parses given both texts. */
function parsePackageFiles(
  manifestText: string,
  definitionText: string,
): DeployablePackage | { readonly reason: string } {
  let manifestBody: unknown;
  try {
    manifestBody = JSON.parse(manifestText);
  } catch (cause) {
    reportError(cause, { operation: "chat_deployable_package_manifest_parse" });
    return { reason: "package.json is not valid JSON" };
  }
  const manifest = PackageManifest(manifestBody);
  if (manifest instanceof type.errors) {
    return { reason: `package.json's ${String(manifest[0]?.path.at(-1) ?? "value")} is invalid` };
  }

  let definitionBody: unknown;
  try {
    definitionBody = JSON.parse(definitionText);
  } catch (cause) {
    reportError(cause, { operation: "chat_deployable_package_definition_parse" });
    return { reason: "definition.json is not valid JSON" };
  }
  const definition = AgentDefinitionShape(definitionBody);
  if (definition instanceof type.errors) {
    return { reason: definitionRejectionReason(definition) };
  }

  const name = definition.name?.trim() || manifest.name?.trim();
  if (name === undefined || name === "") {
    return { reason: "definition.json is missing name" };
  }
  if (definition.systemPrompt.trim() === "") {
    return { reason: "definition.json is missing systemPrompt" };
  }

  return {
    name,
    systemPrompt: definition.systemPrompt,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    ...(definition.schedule !== undefined ? { schedule: definition.schedule } : {}),
  };
}

// Untrusted input: parsed, never cast.
export function deployablePackage(attachments: readonly MailAttachment[]): PackageOutcome {
  const manifest = attachments.find((attachment) => attachment.name === PACKAGE_MANIFEST_NAME);
  if (manifest === undefined) return null;
  const definition = attachments.find((attachment) => attachment.name === AGENT_DEFINITION_NAME);
  if (definition === undefined) return null;
  return parsePackageFiles(manifest.text, definition.text);
}

/** Strips wrapping backticks/colon and returns the canonical file name the
 * text names, or null when it names neither of the two contract files. */
function namedFile(text: string): string | null {
  // A label may be a comment (`// x`, `# x`) and a path (`Scribe/x`); only
  // the final segment names the file.
  const stripped = text
    .trim()
    .replace(/^(\/\/|#)\s*/, "")
    .replace(/^`+/, "")
    .replace(/`+$/, "")
    .replace(/:$/, "")
    .trim();
  const base = stripped.split("/").pop() ?? "";
  if (/^package\.json$/i.test(base)) return PACKAGE_MANIFEST_NAME;
  if (/^definition\.json$/i.test(base)) return AGENT_DEFINITION_NAME;
  return null;
}

/** A fence's info string names a file directly (```package.json) or as the
 * trailing token after a language (```json package.json). */
function namedFileFromInfoString(info: string): string | null {
  const direct = namedFile(info);
  if (direct !== null) return direct;
  const tokens = info.trim().split(/\s+/);
  return namedFile(tokens[tokens.length - 1] ?? "");
}

interface FencedBlockMatch {
  readonly content: string;
  /** Line index the block starts at — the label line above the fence when
   * that's what named it, otherwise the fence line itself. */
  readonly start: number;
  /** Line index just past the closing fence, for slicing it out. */
  readonly end: number;
}

/** The first fenced block in `body` naming each of the two contract files,
 * by info string or by the non-empty line immediately above the fence. */
function findNamedFencedBlocks(lines: readonly string[]): Map<string, FencedBlockMatch> {
  const found = new Map<string, FencedBlockMatch>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fenceMatch = /^```(.*)$/.exec(line.trim());
    if (fenceMatch === null) {
      index++;
      continue;
    }
    const fenceLine = index;
    let name = namedFileFromInfoString(fenceMatch[1] ?? "");
    let labelLine: number | null = null;
    if (name === null && fenceLine > 0) {
      const previous = lines[fenceLine - 1] ?? "";
      const fromLabel = namedFile(previous);
      if (fromLabel !== null) {
        name = fromLabel;
        labelLine = fenceLine - 1;
      }
    }
    const contentLines: string[] = [];
    index++;
    while (index < lines.length && (lines[index] ?? "").trim() !== "```") {
      contentLines.push(lines[index] ?? "");
      index++;
    }
    const end = Math.min(index + 1, lines.length);
    index = end;
    // A label on the fence's first line (`// Scribe/definition.json`, or the
    // bare filename) names the file too; it is not part of the file.
    if (name === null) {
      const firstContent = contentLines.findIndex((content) => content.trim() !== "");
      const fromFirstLine = namedFile(contentLines[firstContent] ?? "");
      if (fromFirstLine !== null) {
        name = fromFirstLine;
        contentLines.splice(0, firstContent + 1);
      }
    }
    if (name !== null && !found.has(name)) {
      found.set(name, {
        content: contentLines.join("\n"),
        start: labelLine ?? fenceLine,
        end,
      });
    }
  }
  return found;
}

// Used when attachments are absent — the actual delivery path today,
// since `mail_send` has no attachments parameter.
export function deployablePackageFromBody(body: string): {
  readonly outcome: DeployablePackage | { readonly reason: string };
  readonly strippedBody: string;
} | null {
  const lines = body.split("\n");
  const blocks = findNamedFencedBlocks(lines);
  const manifest = blocks.get(PACKAGE_MANIFEST_NAME);
  const definition = blocks.get(AGENT_DEFINITION_NAME);
  if (manifest === undefined || definition === undefined) return null;

  const outcome = parsePackageFiles(manifest.content, definition.content);

  const ranges = [manifest, definition].sort((a, b) => a.start - b.start);
  const kept: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    kept.push(...lines.slice(cursor, range.start));
    cursor = range.end;
  }
  kept.push(...lines.slice(cursor));
  const strippedBody = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { outcome, strippedBody };
}

// Attachments win when present (the intended path once `mail_send` grows
// attachments support), otherwise the body's fenced blocks are used.
export function resolveMessagePackage(
  attachments: readonly MailAttachment[],
  body: string,
): { readonly pkg: PackageOutcome; readonly renderedBody: string } {
  const fromAttachments = deployablePackage(attachments);
  if (fromAttachments !== null) return { pkg: fromAttachments, renderedBody: body };
  const fromBody = deployablePackageFromBody(body);
  if (fromBody !== null) return { pkg: fromBody.outcome, renderedBody: fromBody.strippedBody };
  return { pkg: null, renderedBody: body };
}
