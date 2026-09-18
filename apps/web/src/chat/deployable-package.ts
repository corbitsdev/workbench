// The one contract between an agent that writes a package and the client
// that deploys it: a mail reply carrying `package.json` plus a
// `definition.json` of {name, systemPrompt, description?}. The client
// renders the source tree itself (`agent-deploy.ts`), so the agent never
// has to know the deploy pipeline's shape.

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
