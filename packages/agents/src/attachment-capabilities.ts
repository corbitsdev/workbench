import {
  acceptedMimeTypes,
  templateAttachmentCapability,
  IMAGE_MIME_TYPES,
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

// Files an agent can reach through the File Parser (CL-2628) even though its own
// model cannot read them: documents always, and images too when the agent's own
// model is not natively vision-capable (e.g. Myra on kimi, whose endpoint 400s
// on inline image_url parts). The composer accepts these so the user can attach
// them; the client diverts each to the parser upload path rather than sending it
// inline (which would throw the openai-compatible adapter). The inline-mail hub
// guard deliberately does NOT consult this — it stays on native capability so a
// document or image can never ride inline to a model that cannot consume it.
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
  // A parse-capable agent can also read images through the File Parser. Only add
  // them when the model does not already accept images natively (otherwise they
  // ride inline, which is higher fidelity than an OCR pass). Check for native
  // image support explicitly rather than an empty native set, so a future
  // documents-but-not-images capability would still route images to the parser.
  const nativeAcceptsImages = IMAGE_MIME_TYPES.some((mime) =>
    nativeMimeTypes.includes(mime),
  );
  const parserFiles = PARSER_DOCS_BY_AGENT_NAME.get(agentName)
    ? [...DOCUMENT_MIME_TYPES, ...(nativeAcceptsImages ? [] : IMAGE_MIME_TYPES)]
    : [];
  const mimeTypes = [...new Set([...nativeMimeTypes, ...parserFiles])];
  if (mimeTypes.length === 0) return undefined;
  return {
    acceptedMimeTypes: mimeTypes,
    perAttachmentLimitBytes: PER_ATTACHMENT_LIMIT_BYTES,
    perMessageTotalLimitBytes: PER_MESSAGE_TOTAL_LIMIT_BYTES,
  };
}
