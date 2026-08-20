// What the profile card's Message action and shared-workbenches list need,
// resolved against real bench data (CL-5914, CL-5919). Generalizes
// `myra-workbench.ts`'s ensure-style reuse — find an existing 1:1 by
// participant instead of by a fixed title, and fall back to creating one —
// to any profile subject rather than one hardcoded agent.

import { localPartOf } from "@corbits/chat/agent-address";
import {
  createWorkbench,
  findDirectWorkbenchWith,
  listWorkbenches,
  sharedWorkbenchesWith,
  type CreateWorkbenchInput,
  type ProfileSubject,
  type SharedWorkbenchSummary,
} from "@corbits/chat-ui";

import { listAgentInstances } from "./agents-api";

export async function loadSharedWorkbenches(
  tenantId: string,
  viewerPrincipalId: string,
  subject: ProfileSubject,
): Promise<readonly SharedWorkbenchSummary[]> {
  const [workbenches, chats] = await Promise.all([
    listWorkbenches(tenantId, "workbench"),
    listWorkbenches(tenantId, "chat"),
  ]);
  return sharedWorkbenchesWith(
    [...workbenches, ...chats],
    viewerPrincipalId,
    subject.address,
  );
}

/**
 * The chat `POST /workbenches` body for starting a 1:1 with `subject` — a
 * person's chat is keyed by principalId (the address local part, per
 * `timeline.tsx`'s `CurrentUser` doc comment); an agent's chat is keyed by
 * the definitionId of whichever running instance owns `subject.address`,
 * which the caller resolves via `listAgentInstances` and passes in as
 * `agentDefinitionId`. `null` means no such running instance was found —
 * there is nothing honest to create a chat against.
 */
export function dmCreateInputFor(
  subject: ProfileSubject,
  agentDefinitionId: string | null,
): CreateWorkbenchInput | null {
  if (subject.kind === "agent") {
    if (agentDefinitionId === null) return null;
    return {
      kind: "chat",
      definitionId: agentDefinitionId,
      name: subject.displayName,
    };
  }
  return {
    kind: "chat",
    principalId: localPartOf(subject.address),
    name: subject.displayName,
  };
}

export type EnsureProfileDmResult =
  | { readonly kind: "ready"; readonly workbenchId: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Open-or-create the direct workbench with `subject`: reuse a chat or
 * workbench `subject.address` already participates in, else create a fresh
 * chat.
 */
export async function ensureProfileDm(
  tenantId: string,
  subject: ProfileSubject,
): Promise<EnsureProfileDmResult> {
  try {
    const [workbenches, chats] = await Promise.all([
      listWorkbenches(tenantId, "workbench"),
      listWorkbenches(tenantId, "chat"),
    ]);
    const existing =
      findDirectWorkbenchWith(chats, subject.address) ??
      findDirectWorkbenchWith(workbenches, subject.address);
    if (existing !== undefined) {
      return { kind: "ready", workbenchId: existing.id };
    }

    let agentDefinitionId: string | null = null;
    if (subject.kind === "agent") {
      const instances = await listAgentInstances(tenantId);
      const instance = instances.find(
        (candidate) => candidate.address === subject.address,
      );
      agentDefinitionId = instance?.definitionId ?? null;
    }
    const input = dmCreateInputFor(subject, agentDefinitionId);
    if (input === null) {
      return {
        kind: "error",
        message: `No running agent found for @${subject.handle}.`,
      };
    }
    const created = await createWorkbench(tenantId, input);
    return { kind: "ready", workbenchId: created.id };
  } catch (cause) {
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
