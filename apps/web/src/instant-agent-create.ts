// THE one creation verb (CL-6089, retargeted CL-6138): the sidebar's "+"
// button, the command palette's "New workbench", and every other "create
// a workbench" affordance in the app call this directly, one click, no
// dialog, no agent picker, no describe composer — it mints a fresh
// workbench titled "New Workbench" against the account's default setup
// template (the same seeded `assistant` definition backing the home Myra
// workbench, which already opens with the setup greeting: "what do you
// want me around for?"). The conversation itself is what specializes the
// agent into whatever the person wants; the drafting and capability
// machinery already listens for that in-chat, so no definition is
// drafted or created up front here. Explicitly defining a brand-new
// agent template, with its own name/purpose/model/skills chosen up
// front, stays `CreateAgentPanel`'s job (Settings → Agents), unchanged.

import { launchAgentChat } from "./agent-chat-launch";
import { listAgentDefinitions } from "./agents-api";
import { findMyraDefinition } from "./myra-workbench";

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
