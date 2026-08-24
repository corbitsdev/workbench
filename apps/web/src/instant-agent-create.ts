// Every "create a workbench" affordance — the sidebar's "+", the command
// palette's "New workbench", and the zero-workbench land-hop on `/`
// (CL-6486, superseding CL-6138's silent auto-mint) — opens the template
// picker (`pages/new-workbench-picker.tsx`, CL-6342) and calls
// `createWorkbenchFromTemplate` below once a row is chosen. Blank `+`
// mints an empty `kind: "workbench"` channel (no host, no definitionId).
// Named templates mint that same empty channel, then invite existing
// principals — including Myra — so the room is a multi-principal
// channel, never a second agent DM. Explicitly defining a brand-new
// agent, with its own name/purpose/model/skills chosen up front, stays
// `CreateAgentPanel`'s job (Settings → Agents), unchanged.

import { getLogger } from "@corbits/client-log";
import type { QueryClient } from "@tanstack/react-query";
import {
  createWorkbench,
  getConnectGithubState,
  inviteAgent,
  partsForSend,
  patchWorkbenchSettings,
  sendMessage,
  startReviewingGithubRepos,
  workbenchesQueryKeyPrefix,
  type ConnectGithubRepo,
} from "@corbits/chat-ui";
import { listPluginsForTenant } from "@workbench/connections/plugins";
import {
  instantiateWorkbenchTemplate,
  templateSettingsPatch,
} from "@corbits/workflow-catalog";

import {
  deployWorkbenchTemplateBlock,
  fetchWorkbenchTemplateManifest,
} from "./workbench-templates-api";

import { createAgentDefinition, listAgentDefinitions } from "./agents-api";
import { findMyraDefinition } from "./myra-workbench";
import { workbenchPath } from "./workbench-path";

const log = getLogger("web.instant-agent-create");
import type { WorkbenchTemplateId } from "./workbench-templates";

export const NEW_WORKBENCH_TITLE = "New Workbench";

/**
 * Marks the two precondition failures below as intentionally
 * user-facing: their `message` is authored copy, never a raw request
 * path or schema summary, so a caller can show it verbatim. Every
 * other throw on this path (`ApiQueryError`, `ChatApiError`, or a
 * plain `Error` from a package that hasn't opted in) must go through
 * that error type's own describer instead — allow-listing safe
 * throws, rather than denylisting unsafe ones, so a new error type
 * added later fails safe (masked) instead of leaking by default.
 *
 * `kind` lets a caller tell "the setup agent isn't deployed yet" apart
 * from "this template genuinely doesn't exist here" without parsing
 * `message` text: the first is very often a still-provisioning bench
 * (CL-6457's background deploy hasn't finished, or never started
 * without a credential) that the caller should check
 * `fetchAgentReadiness` over before treating as a dead end; the second
 * never resolves itself and should surface as-is.
 */
export class WorkbenchPreconditionError extends Error {
  readonly kind: "setup-agent-missing" | "template-unavailable";
  constructor(
    message: string,
    kind: "setup-agent-missing" | "template-unavailable",
  ) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Consumer-language stand-in for the system precondition this bench
 * hit: "no deployed setup agent" describes an internal implementation
 * detail, never something a person signing in for the first time
 * should have to parse.
 */
const SETUP_AGENT_MISSING_MESSAGE =
  "Your workbench is still finishing setup. Try again in a moment.";

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
 * The template picker's "Create workbench" action (CL-6344 / CL-6982):
 * mints an empty `kind: "workbench"` channel with no host and no
 * `definitionId`. A named template (code-review, due-diligence, GTM)
 * still mints that empty channel, then instantiates its roster —
 * existing principals, including Myra, are invited after mint rather
 * than skipped as "already hosted." Talking to an agent is clicking
 * that agent (find-or-reopen its one DM). This function is the create
 * verb for a room, not a clone of Myra.
 *
 * Setup still has to have seeded the default assistant definition; if
 * it hasn't, we fail with `WorkbenchPreconditionError` rather than
 * minting a hostless room that then can't invite anyone. A template id
 * with no manifest yet (`blank`, "Just start talking") mints a plain
 * untagged channel under the generic `NEW_WORKBENCH_TITLE`. When
 * `pickGithubRepos` is supplied and GitHub is already connected for
 * this tenant, this also drives CL-6386's "select on new-workbench"
 * step — see `PickGithubRepos`'s own doc.
 *
 * `queryClient` invalidates the workbenches list once every template
 * participant has been invited (CL-6594) — `ChatWorkspace`'s own
 * in-room "Invite agent" dialog does the same
 * (`workbenchesQueryKeyPrefix`, `chat-workspace.tsx`'s
 * `refreshWorkbenchLists`) so the room the invite landed in never
 * shows a participant it already has data for as if it never joined.
 * Without this, the room this function `navigate`s to can start life
 * holding a `workbenches` query cached from before the last invite
 * resolved.
 *
 * `firstMessage`, when given (CL-6628's prompt box), is sent as the
 * signed-in person's own opening message once the room and its
 * template participants exist, so it lands after the setup/template
 * greeting rather than racing it — Myra reads the room's actual intent
 * as the next line, not the first.
 */
export async function createWorkbenchFromTemplate(
  tenantId: string,
  templateId: WorkbenchTemplateId,
  navigate: (to: string) => void,
  queryClient: QueryClient,
  pickGithubRepos?: PickGithubRepos,
  firstMessage?: string,
): Promise<void> {
  const definitions = await listAgentDefinitions(tenantId);
  const setupTemplate = findMyraDefinition(definitions);
  if (setupTemplate === undefined) {
    throw new WorkbenchPreconditionError(
      SETUP_AGENT_MISSING_MESSAGE,
      "setup-agent-missing",
    );
  }
  // The manifest comes from the bench library (CL-6344), never from a
  // hardcoded catalog import; reading it is what seeds the shelf
  // (CL-6458). `blank` is the one id with no manifest by design; any
  // other id resolving to nothing means this build ships no such
  // template — fail loud rather than mint a workbench missing its
  // agents. The picker only offers ids the library listed, so this is
  // the race-loser's message, not the everyday path.
  const manifest =
    templateId === "blank"
      ? undefined
      : ((await fetchWorkbenchTemplateManifest(tenantId, templateId)) ??
        undefined);
  if (templateId !== "blank" && manifest === undefined) {
    throw new WorkbenchPreconditionError(
      `A ${templateId} workbench isn't available here yet.`,
      "template-unavailable",
    );
  }
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
    kind: "workbench",
    name: manifest?.title ?? NEW_WORKBENCH_TITLE,
    ...(manifest !== undefined ? { templatePromise: manifest.promise } : {}),
    ...(requiresGithub && !githubAlreadyConnected && manifest !== undefined
      ? { connectGithubRequiredFor: manifest.title }
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
        return current.map((definition) => ({
          handle: definition.name,
          id: definition.id,
        }));
      },
      async createParticipantAgent(request) {
        const created = await createAgentDefinition(tenantId, request);
        return { id: created.id };
      },
      async deployBlockWorkflow(block) {
        return deployWorkbenchTemplateBlock(tenantId, block.assetName);
      },
      async inviteParticipantAgent(id) {
        await inviteAgent(tenantId, workbench.id, id);
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
    await queryClient.invalidateQueries({
      queryKey: workbenchesQueryKeyPrefix(tenantId),
    });
  }

  if (firstMessage !== undefined && firstMessage.trim() !== "") {
    await sendMessage(tenantId, workbench.id, partsForSend(firstMessage, []));
  }

  navigate(workbenchPath(workbench.id));
}
