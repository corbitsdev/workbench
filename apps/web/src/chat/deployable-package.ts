// The one contract between an agent that writes a package and the client
// that deploys it: a reply carrying `package.json` plus a
// `definition.json` of {name, systemPrompt, description?, schedule?} —
// either as mail attachments, or (since `@intx/tools-mail`'s `mail_send`
// has no attachments parameter) as two labelled fenced code blocks in the
// message body. The client renders the source tree itself
// (`agent-deploy.ts`), so the agent never has to know the deploy
// pipeline's shape.

import { type } from "arktype";
import { reportError } from "@corbits/error-sink";

import type { MailAttachment } from "./threads-api";

const AgentDefinition = type({
  name: "string",
  systemPrompt: "string",
  "description?": "string",
  "schedule?": "string",
});

/** A cron string this pipeline accepts: exactly five whitespace-separated
 * fields. No third-party parser — the fields are validated for shape only,
 * `cronSentence` (from `@corbits/workflows/client`) is the semantic check. */
export function isFiveFieldCron(schedule: string): boolean {
  return schedule.trim().split(/\s+/).length === 5;
}

export type DeployablePackage = typeof AgentDefinition.infer;

export const PACKAGE_MANIFEST_NAME = "package.json";
export const AGENT_DEFINITION_NAME = "definition.json";

/** The agent package a message's attachments describe, or null when they
 * are just files. Untrusted input: parsed, never cast. */
export function deployablePackage(
  attachments: readonly MailAttachment[],
): DeployablePackage | null {
  if (!attachments.some((attachment) => attachment.name === PACKAGE_MANIFEST_NAME)) return null;
  const definition = attachments.find((attachment) => attachment.name === AGENT_DEFINITION_NAME);
  if (definition === undefined) return null;
  let body: unknown;
  try {
    body = JSON.parse(definition.text);
  } catch (cause) {
    reportError(cause, { operation: "chat_deployable_package_parse" });
    return null;
  }
  const parsed = AgentDefinition(body);
  if (parsed instanceof type.errors) return null;
  if (parsed.name.trim() === "" || parsed.systemPrompt.trim() === "") return null;
  return parsed;
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
    // A comment label on the fence's first line (`// Scribe/definition.json`)
    // names the file too; it is not part of the file.
    if (name === null) {
      const firstContent = contentLines.findIndex((content) => content.trim() !== "");
      const first = contentLines[firstContent] ?? "";
      if (/^\s*(\/\/|#)/.test(first)) {
        const fromComment = namedFile(first);
        if (fromComment !== null) {
          name = fromComment;
          contentLines.splice(0, firstContent + 1);
        }
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

/** The agent package a message body carries as fenced code blocks, plus
 * the body with those blocks removed. Used when attachments are absent —
 * `@intx/tools-mail`'s `mail_send` has no attachments parameter, so this is
 * the mailed-package contract's actual delivery path today. */
export function deployablePackageFromBody(
  body: string,
): { readonly pkg: DeployablePackage; readonly strippedBody: string } | null {
  const lines = body.split("\n");
  const blocks = findNamedFencedBlocks(lines);
  const manifest = blocks.get(PACKAGE_MANIFEST_NAME);
  const definition = blocks.get(AGENT_DEFINITION_NAME);
  if (manifest === undefined || definition === undefined) return null;
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(definition.content);
  } catch (cause) {
    reportError(cause, { operation: "chat_deployable_package_body_parse" });
    return null;
  }
  const parsed = AgentDefinition(parsedBody);
  if (parsed instanceof type.errors) return null;
  if (parsed.name.trim() === "" || parsed.systemPrompt.trim() === "") return null;

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
  return { pkg: parsed, strippedBody };
}

/** The package a message describes and the body to render for it —
 * attachments win when present (the intended path once `mail_send` grows
 * attachments support), otherwise the body's fenced blocks are read and
 * stripped from the rendered text. */
export function resolveMessagePackage(
  attachments: readonly MailAttachment[],
  body: string,
): { readonly pkg: DeployablePackage | null; readonly renderedBody: string } {
  const fromAttachments = deployablePackage(attachments);
  if (fromAttachments !== null) return { pkg: fromAttachments, renderedBody: body };
  const fromBody = deployablePackageFromBody(body);
  if (fromBody !== null) return { pkg: fromBody.pkg, renderedBody: fromBody.strippedBody };
  return { pkg: null, renderedBody: body };
}
