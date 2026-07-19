import type { AgentInstance } from "./hub-api";
import type { Member } from "../hooks/use-members";

const USER_ADDRESS_PREFIX = "usr_";

const SYSTEM_LOCAL_LABELS: Record<string, string> = {
  myra: "Myra",
  hub: "Workbench",
  tasks: "Tasks",
};

const PRINCIPAL_ID_RE = /^prn_[A-Za-z0-9]+$/u;
const INSTANCE_ID_RE = /^ins_[A-Za-z0-9_-]+$/u;

export type ApprovalDisplayLookups = {
  principalById: Map<string, string>;
  principalByRefId: Map<string, string>;
  agentByInstanceId: Map<string, string>;
  agentByAddress: Map<string, string>;
};

export function buildApprovalDisplayLookups(
  members: Member[],
  instances: AgentInstance[],
): ApprovalDisplayLookups {
  const principalById = new Map<string, string>();
  const principalByRefId = new Map<string, string>();
  for (const member of members) {
    principalById.set(member.id, member.name);
    principalByRefId.set(member.refId, member.name);
  }

  const agentByInstanceId = new Map<string, string>();
  const agentByAddress = new Map<string, string>();
  for (const instance of instances) {
    agentByInstanceId.set(instance.id, instance.agentName);
    agentByAddress.set(instance.address.toLowerCase(), instance.agentName);
  }

  return {
    principalById,
    principalByRefId,
    agentByInstanceId,
    agentByAddress,
  };
}

export function splitMailAddress(
  address: string,
): { local: string; domain: string } | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

function bareUserRefIdFromLocal(local: string): string {
  return local.startsWith(USER_ADDRESS_PREFIX)
    ? local.slice(USER_ADDRESS_PREFIX.length)
    : local;
}

function baseMailboxLocal(local: string): string {
  const withoutTag = local.split("+")[0] ?? local;
  return withoutTag.toLowerCase();
}

function instanceIdFromInsLocal(local: string): string | null {
  const base = local.split("+")[0] ?? local;
  if (!base.startsWith("ins_")) return null;
  return base;
}

export function formatMailboxAddress(
  address: string,
  lookups: ApprovalDisplayLookups,
): string {
  const trimmed = address.trim();
  const parts = splitMailAddress(trimmed);
  if (parts === null) {
    return humanizeOpaqueId(trimmed, lookups);
  }

  const baseLocal = baseMailboxLocal(parts.local);
  const systemLabel = SYSTEM_LOCAL_LABELS[baseLocal];
  if (systemLabel !== undefined) return systemLabel;

  const byAddress = lookups.agentByAddress.get(trimmed.toLowerCase());
  if (byAddress !== undefined) return byAddress;

  if (parts.local.startsWith("ins_")) {
    const instanceId = instanceIdFromInsLocal(parts.local);
    if (instanceId !== null) {
      const byId = lookups.agentByInstanceId.get(instanceId);
      if (byId !== undefined) return byId;
    }
    return "Agent";
  }

  const userName = lookups.principalByRefId.get(
    bareUserRefIdFromLocal(parts.local),
  );
  if (userName !== undefined) return userName;

  if (PRINCIPAL_ID_RE.test(parts.local)) {
    return lookups.principalById.get(parts.local) ?? "Team member";
  }

  return trimmed.includes("ins_") || trimmed.includes("prn_")
    ? "Recipient"
    : trimmed;
}

export function humanizeOpaqueId(
  value: string,
  lookups: ApprovalDisplayLookups,
): string {
  if (PRINCIPAL_ID_RE.test(value)) {
    return lookups.principalById.get(value) ?? "Team member";
  }
  if (INSTANCE_ID_RE.test(value)) {
    return lookups.agentByInstanceId.get(value) ?? "Agent";
  }
  if (value.includes("@")) {
    return formatMailboxAddress(value, lookups);
  }
  return value;
}

/** Headline for mail_send tool rows in chat activity summaries. */
export function mailSendToolSummaryHeadline(
  to: unknown,
  lookups: ApprovalDisplayLookups,
  lookupsLoading: boolean,
): string {
  if (typeof to === "string" && to.trim() !== "") {
    const recipient = lookupsLoading
      ? "Recipient"
      : formatMailboxAddress(to, lookups);
    return `Send mail to ${recipient}`;
  }
  return "Send mail";
}
