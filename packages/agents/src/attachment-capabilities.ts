import {
  acceptedMimeTypes,
  templateAttachmentCapability,
  type AttachmentCapability,
} from "@workbench/catalog";
import {
  ATTACHMENT_ALLOWLIST,
  PER_ATTACHMENT_LIMIT_BYTES,
  PER_MESSAGE_TOTAL_LIMIT_BYTES,
} from "@intx/types";
import { AGENT_TEMPLATES, type AgentTemplate } from "./templates";

export {
  acceptedMimeTypes,
  ATTACHMENT_CAPABILITIES,
  type AttachmentCapability,
} from "@workbench/catalog";

// Resolved once from the agent registry: each template carries the inference
// credential (adapter plugin) and modelConfig the capability derives from.
// New agents flow through automatically; an unknown name fails closed.
const CAPABILITY_BY_AGENT_NAME = new Map<string, AttachmentCapability>(
  AGENT_TEMPLATES.map((template) => [
    template.name,
    templateAttachmentCapability(template),
  ]),
);

export function attachmentCapabilityForAgent(
  agentName: string,
): AttachmentCapability {
  return CAPABILITY_BY_AGENT_NAME.get(agentName) ?? "none";
}

// Documents an agent can reach through the File Parser (CL-2628) even though its
// own model cannot read them. The composer accepts these so the user can attach
// them; the client diverts each to the parser upload path rather than sending it
// inline (which would throw the openai-compatible adapter). The inline-mail hub
// guard deliberately does NOT consult this — it stays on native capability so a
// document can never ride inline to a doc-incapable model.
const DOCUMENT_MIME_TYPES: string[] = Object.entries(ATTACHMENT_ALLOWLIST)
  .filter(([, category]) => category === "document")
  .map(([mime]) => mime);

function agentSupportsParsedDocuments(template: AgentTemplate): boolean {
  return template.capabilities.tools.some(
    (tool) => tool === "parse_file" || tool.endsWith(":parse_file"),
  );
}

const PARSER_DOCS_BY_AGENT_NAME = new Map<string, boolean>(
  AGENT_TEMPLATES.map((template) => [
    template.name,
    agentSupportsParsedDocuments(template),
  ]),
);

// The full policy the composer needs: the agent's accepted MIME set (narrowed
// to what its adapter can consume) plus the system attachment size ceilings.
// Undefined when the agent can take no attachments at all.
export interface AgentAttachmentPolicy {
  acceptedMimeTypes: string[];
  perAttachmentLimitBytes: number;
  perMessageTotalLimitBytes: number;
}

export function attachmentPolicyForAgent(
  agentName: string,
): AgentAttachmentPolicy | undefined {
  const nativeMimeTypes = acceptedMimeTypes(
    attachmentCapabilityForAgent(agentName),
  );
  const parserDocs = PARSER_DOCS_BY_AGENT_NAME.get(agentName)
    ? DOCUMENT_MIME_TYPES
    : [];
  const mimeTypes = [...new Set([...nativeMimeTypes, ...parserDocs])];
  if (mimeTypes.length === 0) return undefined;
  return {
    acceptedMimeTypes: mimeTypes,
    perAttachmentLimitBytes: PER_ATTACHMENT_LIMIT_BYTES,
    perMessageTotalLimitBytes: PER_MESSAGE_TOTAL_LIMIT_BYTES,
  };
}
