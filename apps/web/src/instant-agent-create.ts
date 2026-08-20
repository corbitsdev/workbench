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
import {
  instantiateWorkbenchTemplate,
  templateSettingsPatch,
  workbenchTemplate,
} from "@corbits/workflow-catalog";

import { launchAgentChat } from "./agent-chat-launch";
import { createAgentDefinition, listAgentDefinitions } from "./agents-api";
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

/**
 * The template picker's "Create workbench" action (CL-6344): mints a
 * fresh "New Workbench" chat against the same default setup template
 * `createAgentAndLaunch` uses, passing the picked row's id through as
 * `templateId` so the room opens with that template's own intro
 * (`packages/chat/src/routes.ts`'s `POST /workbenches` resolves it into
 * the canned greeting). When the id names a real manifest
 * (`workbenchTemplate`), this also creates its participant agent
 * definitions and records its required connections as pending — see
 * `instantiateWorkbenchTemplate`'s own doc for exactly what that does
 * and does not do yet (inviting the reviewers into the room, and the
 * GitHub connect card itself, are the next slice). A template id with
 * no manifest yet (`blank`, "Just start talking") mints a plain
 * untagged chat, exactly like before templates existed.
 */
export async function createWorkbenchFromTemplate(
  tenantId: string,
  templateId: WorkbenchTemplateId,
  navigate: (to: string) => void,
): Promise<void> {
  const definitions = await listAgentDefinitions(tenantId);
  const setupTemplate = findMyraDefinition(definitions);
  if (setupTemplate === undefined) {
    throw new Error("No default setup agent found for this workbench.");
  }
  const manifest = workbenchTemplate(templateId);
  const workbench = await createWorkbench(tenantId, {
    kind: "chat",
    definitionId: setupTemplate.id,
    name: NEW_WORKBENCH_TITLE,
    ...(manifest !== undefined ? { templatePromise: manifest.promise } : {}),
  });

  if (manifest !== undefined) {
    const result = await instantiateWorkbenchTemplate(manifest, {
      async listAgentHandles() {
        const current = await listAgentDefinitions(tenantId);
        return current.map((definition) => definition.name);
      },
      async createParticipantAgent(request) {
        const created = await createAgentDefinition(tenantId, request);
        return { id: created.id };
      },
      async recordPendingConnections(pendingConnections) {
        await patchWorkbenchSettings(
          tenantId,
          workbench.id,
          templateSettingsPatch(manifest.id, pendingConnections),
        );
      },
    });
    // Honest setup-gap notes, not silent stubs — see
    // `instantiateWorkbenchTemplate`'s own doc on what these mean and why
    // no live webhook trigger exists yet.
    for (const todo of result.webhookTriggerTodos) {
      console.error(todo);
    }
  }

  navigate(workbenchPath(workbench.id));
}
