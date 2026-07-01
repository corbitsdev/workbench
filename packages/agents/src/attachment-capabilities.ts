import {
  acceptedMimeTypes,
  templateAttachmentCapability,
  type AttachmentCapability,
} from "@workbench/catalog";
import {
  PER_ATTACHMENT_LIMIT_BYTES,
  PER_MESSAGE_TOTAL_LIMIT_BYTES,
} from "@intx/types";
import { AGENT_TEMPLATES } from "./templates";

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
  const mimeTypes = acceptedMimeTypes(attachmentCapabilityForAgent(agentName));
  if (mimeTypes.length === 0) return undefined;
  return {
    acceptedMimeTypes: mimeTypes,
    perAttachmentLimitBytes: PER_ATTACHMENT_LIMIT_BYTES,
    perMessageTotalLimitBytes: PER_MESSAGE_TOTAL_LIMIT_BYTES,
  };
}
