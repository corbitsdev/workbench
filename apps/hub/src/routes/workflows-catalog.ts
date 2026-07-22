import { getAncestorChain } from "@intx/db";
import { getLogger } from "@intx/log";
import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import type { AgentRepoStore } from "@intx/hub-sessions";
import {
  classifyWorkflowSteps,
  countHumanGates,
  type ClassifiedFlowStep,
  type DisplayFlowStep,
} from "@workbench/agents";
import {
  orderCatalogEntries,
  scheduleScopesForKind,
  WorkflowCatalogSchema,
  type WorkflowCatalogEntry,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { getRequestedUserContext } from "../lib/user-context";
import {
  distinctRunnableKindsFromDeployments,
  listRunnableWorkflowDeployments,
} from "../lib/workflow-run-gate";
import { readWorkflowDefinition } from "../services/workflow-deploy";
import { readMemberPreferences } from "../lib/member-preferences";
import {
  loadWorkflowDisplayFlows,
  loadWorkflowGateInfos,
  loadWorkflowIntakeFields,
} from "../lib/workflow-catalog";
import { isKindStructurallyAttachable } from "../lib/workflow-gate-info";
import { getRootTenantId, lookupMember } from "../lib/tenant-provisioning";

const log = getLogger("workflows-catalog");

const ErrorResponse = type({ error: "string" });

function humanizeKind(kind: string): string {
  const spaced = kind
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (spaced === "") return kind;
  return spaced
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function readFavoriteKinds(db: HubDb, userId: string): Promise<string[]> {
  const rootTenantId = await getRootTenantId(db);
  const member = rootTenantId
    ? await lookupMember(db, { tenantId: rootTenantId, userId })
    : null;
  if (!member) return [];
  const prefs = await readMemberPreferences(
    db,
    member.tenantId,
    member.principalId,
  );
  return prefs.favoriteWorkflows ?? [];
}

async function classifyKindSteps(
  repoStore: AgentRepoStore,
  kind: string,
  displayFlow: readonly DisplayFlowStep[] | undefined,
): Promise<ClassifiedFlowStep[]> {
  try {
    return classifyWorkflowSteps(
      await readWorkflowDefinition(repoStore, kind),
      displayFlow,
    );
  } catch (err) {
    // A runnable kind whose definition cannot be read still belongs in the
    // catalog (it is startable); it just has no preview. Surface, do not drop.
    log.warn("Workflow definition unreadable for catalog preview: {error}", {
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// GET /workflows — the single call that powers the whole Workflows page: every
// runnable workflow for the caller's tenant chain, each annotated with the
// member's favorite state and its classified step flow, favorites pinned first.
export function createWorkflowsCatalogRouter(deps: {
  db: HubDb;
  repoStore: AgentRepoStore;
}): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.get(
    "/workflows",
    describeRoute({
      tags: ["Workflows"],
      summary: "Workflows page catalog",
      description:
        "Every runnable workflow for the caller's active workbench (and inherited from ancestor tenants), one entry per kind, annotated with the member's favorite state and the classified step flow used by the preview. Favorites are pinned first. Optional `?tenantId=` selects a workbench the user belongs to.",
      parameters: [
        {
          name: "tenantId",
          in: "query",
          required: false,
          description:
            "Target workbench tenant id. Omit for the active workbench.",
          schema: { type: "string" },
        },
      ],
      responses: {
        200: {
          description: "The workflow catalog for the page",
          content: {
            "application/json": { schema: resolver(WorkflowCatalogSchema) },
          },
        },
        403: {
          description:
            "User context not found or forbidden for the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context, forbidden } = await getRequestedUserContext(
        deps.db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!context) return c.json({ error: "User context not found" }, 403);

      const chain = await getAncestorChain(deps.db, context.tenantId);
      const deployments = await listRunnableWorkflowDeployments(deps.db, chain);
      const kinds = distinctRunnableKindsFromDeployments(deployments);
      const favoriteKinds = await readFavoriteKinds(deps.db, userId);
      const favoriteSet = new Set(favoriteKinds);
      // The declared display flow per kind (when the workflow ships one) — the
      // same DISPLAY_STEPS the client run stepper consumes — so the preview
      // groups and labels steps identically. Absent kinds fall back to the
      // per-step stepOrder projection.
      const displayFlows = await loadWorkflowDisplayFlows();
      // Gate shape + intake form per kind (CL-3508/CL-3509): whether the kind is
      // attachable to a brief schedule, and the intake fields the attach UI
      // collects for a requiresIntake kind. Both read from the committed embedded
      // catalog alongside the display flows.
      const gateInfos = await loadWorkflowGateInfos();
      const intakeFieldsByKind = await loadWorkflowIntakeFields();

      const entries: WorkflowCatalogEntry[] = [];
      for (const entry of kinds) {
        const steps = await classifyKindSteps(
          deps.repoStore,
          entry.kind,
          displayFlows.get(entry.kind),
        );
        const gateInfo = gateInfos.get(entry.kind);
        const attachable =
          gateInfo !== undefined &&
          isKindStructurallyAttachable(gateInfo, entry.kind);
        const intakeFields =
          gateInfo?.requiresIntake === true
            ? intakeFieldsByKind.get(entry.kind)
            : undefined;
        const scopes = scheduleScopesForKind(entry.kind, attachable);
        entries.push({
          kind: entry.kind,
          label: entry.label ?? humanizeKind(entry.kind),
          ...(entry.description !== undefined
            ? { description: entry.description }
            : {}),
          isFavorite: favoriteSet.has(entry.kind),
          stepCount: steps.length,
          pauseCount: countHumanGates(steps),
          steps,
          attachable,
          ...(intakeFields !== undefined && intakeFields.length > 0
            ? { intakeFields }
            : {}),
          allowedScopes: scopes.allowedScopes,
          defaultScope: scopes.defaultScope,
        });
      }

      return c.json({ entries: orderCatalogEntries(entries, favoriteKinds) });
    },
  );

  return router;
}
