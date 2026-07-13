import { and, eq, inArray } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { splitMailAddress, USER_ADDRESS_PREFIX } from "@workbench/hub-agent";
import type { HubDb } from "../db";
import { workflowRun } from "../db/schema";
import { loadWorkflowKindLabels } from "./workflow-kind-labels";

const { agent, agentInstance, principal, user } = intxSchema;

const SYSTEM_LOCAL_LABELS: Record<string, string> = {
  myra: "Myra",
  hub: "Workbench",
  tasks: "Tasks",
};

export function extractSenderMailboxAddress(fromHeader: string): string {
  const trimmed = fromHeader.trim();
  const start = trimmed.indexOf("<");
  const end = trimmed.lastIndexOf(">");
  if (start >= 0 && end > start) {
    return trimmed.slice(start + 1, end).trim();
  }
  return trimmed;
}

function bareUserRefIdFromLocal(local: string): string {
  return local.startsWith(USER_ADDRESS_PREFIX)
    ? local.slice(USER_ADDRESS_PREFIX.length)
    : local;
}

/** Deployment id encoded in `ins_<deploymentId>` or `ins_<deploymentId>-<stepId>`. */
export function deploymentIdFromInsMailboxAddress(addr: string): string | null {
  const parts = splitMailAddress(addr);
  if (parts === null || !parts.local.startsWith("ins_")) return null;
  const core = (parts.local.split("+")[0] ?? parts.local).slice(4);
  const dash = core.indexOf("-");
  return dash >= 0 ? core.slice(0, dash) : core;
}

function instanceIdFromInsMailboxAddress(addr: string): string | null {
  const parts = splitMailAddress(addr);
  if (parts === null || !parts.local.startsWith("ins_")) return null;
  return parts.local.split("+")[0] ?? parts.local;
}

function labelFromWorkflowRunMeta(
  meta: { label?: string } | null | undefined,
  kind: string,
  kindLabels: Map<string, string>,
): string {
  const fromMeta = meta?.label?.trim();
  if (fromMeta !== undefined && fromMeta !== "") return fromMeta;
  return kindLabels.get(kind) ?? kind;
}

function shouldPreferWorkflowLabel(agentName: string): boolean {
  return agentName.startsWith("supervisor-") || !agentName.includes(" ");
}

/**
 * Batch-resolve mailbox sender addresses in a tenant to human labels.
 * Keys are normalized mailbox addresses (not full RFC From header strings).
 */
export async function resolveSenderDisplayNames(
  db: HubDb,
  tenantId: string,
  fromHeaderValues: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const addresses = new Set<string>();
  for (const header of fromHeaderValues) {
    if (header.length === 0) continue;
    addresses.add(extractSenderMailboxAddress(header));
  }

  const insAddresses: string[] = [];
  const userRefIds = new Set<string>();

  for (const addr of addresses) {
    const parts = splitMailAddress(addr);
    if (parts === null) continue;
    const baseLocal = (parts.local.split("+")[0] ?? parts.local).toLowerCase();
    const systemLabel = SYSTEM_LOCAL_LABELS[baseLocal];
    if (systemLabel !== undefined) {
      out.set(addr, systemLabel);
      continue;
    }
    if (parts.local.startsWith("ins_")) {
      insAddresses.push(addr);
      continue;
    }
    userRefIds.add(bareUserRefIdFromLocal(parts.local));
  }

  if (insAddresses.length > 0) {
    const rows = await db
      .select({
        address: agentInstance.address,
        name: agent.name,
      })
      .from(agentInstance)
      .innerJoin(agent, eq(agentInstance.agentId, agent.id))
      .where(
        and(
          eq(agentInstance.tenantId, tenantId),
          inArray(agentInstance.address, insAddresses),
        ),
      );
    for (const row of rows) {
      out.set(row.address, row.name);
    }
  }

  const unresolvedIns = insAddresses.filter((addr) => !out.has(addr));
  if (unresolvedIns.length > 0) {
    const instanceIds = [
      ...new Set(
        unresolvedIns
          .map(instanceIdFromInsMailboxAddress)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (instanceIds.length > 0) {
      const byId = await db
        .select({
          id: agentInstance.id,
          address: agentInstance.address,
          name: agent.name,
        })
        .from(agentInstance)
        .innerJoin(agent, eq(agentInstance.agentId, agent.id))
        .where(
          and(
            eq(agentInstance.tenantId, tenantId),
            inArray(agentInstance.id, instanceIds),
          ),
        );
      const idToName = new Map(byId.map((row) => [row.id, row.name]));
      for (const row of byId) {
        out.set(row.address, row.name);
      }
      for (const addr of unresolvedIns) {
        if (out.has(addr)) continue;
        const instanceId = instanceIdFromInsMailboxAddress(addr);
        if (instanceId === null) continue;
        const name = idToName.get(instanceId);
        if (name !== undefined) out.set(addr, name);
      }
    }

    const stillUnresolved = unresolvedIns.filter((addr) => !out.has(addr));
    if (stillUnresolved.length > 0) {
      const deploymentIds = [
        ...new Set(
          stillUnresolved
            .map(deploymentIdFromInsMailboxAddress)
            .filter((id): id is string => id !== null && id !== ""),
        ),
      ];
      if (deploymentIds.length > 0) {
        const kindLabels = await loadWorkflowKindLabels();
        const depRows = await db
          .select({
            deploymentId: workflowRun.deploymentId,
            kind: workflowRun.kind,
            meta: workflowRun.meta,
          })
          .from(workflowRun)
          .where(
            and(
              eq(workflowRun.tenantId, tenantId),
              inArray(workflowRun.deploymentId, deploymentIds),
            ),
          );
        const depToLabel = new Map<string, string>();
        for (const row of depRows) {
          if (row.deploymentId === null) continue;
          depToLabel.set(
            row.deploymentId,
            labelFromWorkflowRunMeta(row.meta, row.kind, kindLabels),
          );
        }
        for (const addr of stillUnresolved) {
          const depId = deploymentIdFromInsMailboxAddress(addr);
          if (depId === null) continue;
          const workflowLabel = depToLabel.get(depId);
          if (workflowLabel === undefined) continue;
          const existing = out.get(addr);
          if (existing === undefined || shouldPreferWorkflowLabel(existing)) {
            out.set(addr, workflowLabel);
          }
        }
      }
    }
  }

  if (userRefIds.size > 0) {
    const refIds = [...userRefIds];
    const rows = await db
      .select({ refId: principal.refId, name: user.name })
      .from(principal)
      .innerJoin(user, eq(principal.refId, user.id))
      .where(
        and(
          eq(principal.tenantId, tenantId),
          eq(principal.kind, "user"),
          inArray(principal.refId, refIds),
        ),
      );
    const refIdToName = new Map(rows.map((row) => [row.refId, row.name]));
    for (const addr of addresses) {
      if (out.has(addr)) continue;
      const parts = splitMailAddress(addr);
      if (parts === null) continue;
      const name = refIdToName.get(bareUserRefIdFromLocal(parts.local));
      if (name !== undefined) out.set(addr, name);
    }
  }

  return out;
}

export function attachFromDisplay(
  fromHeader: string,
  displays: Map<string, string>,
): string | undefined {
  const addr = extractSenderMailboxAddress(fromHeader);
  const display = displays.get(addr);
  if (display === undefined || display === fromHeader) return undefined;
  return display;
}