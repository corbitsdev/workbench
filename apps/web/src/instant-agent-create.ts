// THE one creation verb (CL-6089, retargeted CL-6138) for the bench's
// zero-workbench land-hop (`home-page.tsx`): it mints a fresh workbench
// titled "New Workbench" against the account's default setup template (the
// same seeded `assistant` definition backing the home Myra workbench,
// which already opens with the setup greeting: "what do you want me
// around for?"). The conversation itself is what specializes the agent
// into whatever the person wants; the drafting and capability machinery
// already listens for that in-chat, so no definition is drafted or
// created up front here. Explicitly defining a brand-new agent template,
// with its own name/purpose/model/skills chosen up front, stays
// `CreateAgentPanel`'s job (Settings → Agents), unchanged.
//
// Every other "create a workbench" affordance — the sidebar's "+", the
// command palette's "New workbench" — opens the template picker
// (`pages/new-workbench-picker.tsx`) instead (CL-6342, superseding
// CL-6138's direct mint for those entry points): `createWorkbenchFromTemplate`
// below is what the picker's "Create workbench" button calls once a row is
// chosen.

import { createWorkbench, patchWorkbenchSettings } from "@corbits/chat-ui";

import { launchAgentChat } from "./agent-chat-launch";
import { listAgentDefinitions } from "./agents-api";
import { findMyraDefinition } from "./myra-workbench";
import { workbenchPath } from "./workbench-path";
import type { WorkbenchTemplateId } from "./workbench-templates";

export const NEW_WORKBENCH_TITLE = "New Workbench";

/**
 * Finds the account's default setup template (the seeded `assistant`
 * definition) and launches a brand-new "New Workbench" chat against it.
 * Throws if the tenant has no deployed setup template — a bench without
 * one predates seeding and needs an operator, not a client-side retry.
 */
export async function createAgentAndLaunch(
  tenantId: string,
  navigate: (to: string) => void,
): Promise<void> {
  const definitions = await listAgentDefinitions(tenantId);
  const template = findMyraDefinition(definitions);
  if (template === undefined) {
    throw new Error("No default setup agent found for this workbench.");
  }
  await launchAgentChat(tenantId, template.id, navigate, NEW_WORKBENCH_TITLE);
}

/** What a picker row's selection means for the workbench it mints, until a
 * real template-instantiation pipeline exists (a separate ticket) — for
 * now, only a `chat/purpose` tag distinguishes them. `undefined` leaves the
 * workbench untagged, exactly like today's plain mint. */
const TEMPLATE_PURPOSE: Record<WorkbenchTemplateId, string | undefined> = {
  "code-review": "Code review",
  blank: undefined,
};

/**
 * The template picker's "Create workbench" action: mints a fresh
 * "New Workbench" chat against the same default setup template
 * `createAgentAndLaunch` uses, then tags it with the chosen template's
 * `chat/purpose` (Settings and the room's own top bar already read that
 * field). Real template instantiation — provisioning the reviewers, the
 * GitHub connect step — is a separate ticket; this only records which row
 * the person picked.
 */
export async function createWorkbenchFromTemplate(
  tenantId: string,
  templateId: WorkbenchTemplateId,
  navigate: (to: string) => void,
): Promise<void> {
  const definitions = await listAgentDefinitions(tenantId);
  const template = findMyraDefinition(definitions);
  if (template === undefined) {
    throw new Error("No default setup agent found for this workbench.");
  }
  const workbench = await createWorkbench(tenantId, {
    kind: "chat",
    definitionId: template.id,
    name: NEW_WORKBENCH_TITLE,
  });
  const purpose = TEMPLATE_PURPOSE[templateId];
  if (purpose !== undefined) {
    await patchWorkbenchSettings(tenantId, workbench.id, {
      "chat/purpose": purpose,
    });
  }
  navigate(workbenchPath(workbench.id));
}
