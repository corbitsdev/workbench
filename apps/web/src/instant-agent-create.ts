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

import { getLogger } from "@corbits/client-log";
import {
  createWorkbench,
  getConnectGithubState,
  patchWorkbenchSettings,
  startReviewingGithubRepos,
  type ConnectGithubRepo,
} from "@corbits/chat-ui";
import { listPluginsForTenant } from "@workbench/connections/plugins";
import {
  instantiateWorkbenchTemplate,
  templateSettingsPatch,
  workbenchTemplate,
} from "@corbits/workflow-catalog";

import { launchAgentChat } from "./agent-chat-launch";
import { createAgentDefinition, listAgentDefinitions } from "./agents-api";
import { findMyraDefinition } from "./myra-workbench";
import { workbenchPath } from "./workbench-path";

const log = getLogger("web.instant-agent-create");
import type { WorkbenchTemplateId } from "./workbench-templates";

export const NEW_WORKBENCH_TITLE = "New Workbench";

/**
 * Presents the connected org's repo list for the person to pick from once
 * the workbench exists — the create flow's own "select" half of CL-6386
 * ("connect in Plugins; select on new-workbench"). Resolving `null` means
 * "skip" (the person closed the picker without choosing); an empty array
 * is a legitimate "review nothing yet" choice, distinct from skipping.
 */
export type PickGithubRepos = (args: {
  readonly orgName: string;
  readonly repos: readonly ConnectGithubRepo[];
  readonly selectedRepoIds: readonly string[];
}) => Promise<readonly string[] | null>;

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
 * untagged chat, exactly like before templates existed. When
 * `pickGithubRepos` is supplied and GitHub is already connected for this
 * tenant, this also drives CL-6386's "select on new-workbench" step —
 * see `PickGithubRepos`'s own doc.
 */
export async function createWorkbenchFromTemplate(
  tenantId: string,
  templateId: WorkbenchTemplateId,
  navigate: (to: string) => void,
  pickGithubRepos?: PickGithubRepos,
): Promise<void> {
  const definitions = await listAgentDefinitions(tenantId);
  const setupTemplate = findMyraDefinition(definitions);
  if (setupTemplate === undefined) {
    throw new Error("No default setup agent found for this workbench.");
  }
  const manifest = workbenchTemplate(templateId);
  const requiresGithub =
    manifest?.requiredConnections.includes("github") ?? false;

  // GitHub already connected (established from the Plugins page, CL-6386)
  // means this create flow can skip the in-room connect card entirely and
  // go straight to repo selection once the workbench exists. Not yet
  // connected keeps today's exact behaviour: the in-room card stays the
  // just-in-time fallback.
  const githubAlreadyConnected =
    requiresGithub && pickGithubRepos !== undefined
      ? (await listPluginsForTenant(tenantId)).some(
          (plugin) =>
            plugin.descriptor.id === "github" && plugin.status === "connected",
        )
      : false;

  const workbench = await createWorkbench(tenantId, {
    kind: "chat",
    definitionId: setupTemplate.id,
    name: NEW_WORKBENCH_TITLE,
    ...(manifest !== undefined ? { templatePromise: manifest.promise } : {}),
    ...(requiresGithub && !githubAlreadyConnected
      ? { connectGithubRequiredFor: manifest?.title ?? "" }
      : {}),
  });

  if (githubAlreadyConnected && pickGithubRepos !== undefined) {
    const state = await getConnectGithubState(tenantId, workbench.id);
    if (state.kind === "connected" && state.repos.length > 0) {
      const repoIds = await pickGithubRepos({
        orgName: state.orgName,
        repos: state.repos,
        selectedRepoIds: state.selectedRepoIds,
      });
      if (repoIds !== null && repoIds.length > 0) {
        await startReviewingGithubRepos(tenantId, workbench.id, repoIds);
      }
    }
  }

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
      log.error(todo);
    }
  }

  navigate(workbenchPath(workbench.id));
}
