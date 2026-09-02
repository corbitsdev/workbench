// Routine target discovery (CL-7351): the one list of deployed, frozen
// definitions a routine may reference, shared by every authoring surface
// (the web picker, Myra's routine tools, the routine resolver in
// ./target.ts). Built over native rows — `workflow_definition` joined to
// its frozen `workflow_definition_version` — and `@intx/authz`'s
// `authorize`, because Interchange has no per-principal "launchable
// definitions" query (docs/workflow-model.md, "What is not native").

import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import { authorize } from "@intx/authz";
import type { DB } from "@intx/db";
import { workflowDefinition, workflowDefinitionVersion } from "@intx/db/schema";
import type { ConditionRegistry, GrantStore } from "@intx/types/authz";
import { WorkflowProjectionDefinition } from "@intx/types/sidecar";
import { type } from "arktype";
import { isWorkbenchHostDefinitionName } from "@corbits/chat/workbench-host-naming";
import {
  isAutomatableWorkflowName,
  isConversationalWorkflowName,
  workflowDisplayName,
} from "@corbits/workflow-catalog";

import type { RoutineTarget, RoutineTargetKind } from "./client";

export type LaunchableDefinition = {
  readonly definitionId: string;
  readonly definitionAssetId: string;
  readonly name: string;
  readonly description: string | null;
  readonly wireHash: string;
  readonly wireProjection: unknown;
};

/**
 * The newest launchable definition per source asset in a tenant: an
 * `authored` row with `status = 'deployed'` whose current version row is
 * frozen (non-null `approved_wire_hash`, `grant_snapshot`, and
 * `wire_projection`). This is the follow-latest rule from
 * docs/workflow-model.md as one query; the routine launch resolver reads
 * the same rows for one asset. Not authorized — callers gate what leaves.
 */
export async function listLaunchableDefinitions(
  db: DB["db"],
  tenantId: string,
): Promise<readonly LaunchableDefinition[]> {
  const rows = await db
    .selectDistinctOn([workflowDefinition.assetId], {
      definitionId: workflowDefinition.id,
      definitionAssetId: workflowDefinition.assetId,
      name: workflowDefinition.name,
      description: workflowDefinition.description,
      wireHash: workflowDefinitionVersion.approvedWireHash,
      wireProjection: workflowDefinitionVersion.wireProjection,
    })
    .from(workflowDefinition)
    .innerJoin(
      workflowDefinitionVersion,
      and(
        eq(workflowDefinitionVersion.definitionId, workflowDefinition.id),
        eq(
          workflowDefinitionVersion.version,
          workflowDefinition.currentVersion,
        ),
      ),
    )
    .where(
      and(
        eq(workflowDefinition.tenantId, tenantId),
        eq(workflowDefinition.status, "deployed"),
        eq(workflowDefinition.origin, "authored"),
        isNotNull(workflowDefinition.assetId),
        isNotNull(workflowDefinitionVersion.approvedWireHash),
        isNotNull(workflowDefinitionVersion.grantSnapshot),
        isNotNull(workflowDefinitionVersion.wireProjection),
      ),
    )
    .orderBy(
      asc(workflowDefinition.assetId),
      desc(workflowDefinition.createdAt),
      desc(workflowDefinition.id),
    );
  return rows.flatMap((row) =>
    row.definitionAssetId === null || row.wireHash === null
      ? []
      : [
          {
            ...row,
            definitionAssetId: row.definitionAssetId,
            wireHash: row.wireHash,
          },
        ],
  );
}

/**
 * The contract's definition of an agent is "a single-step conversational
 * workflow" — both halves are checked: the catalog says the name is
 * conversational, and the frozen projection is one `step` primitive.
 */
function computeRoutineTargetKind(
  name: string,
  wireProjection: unknown,
): RoutineTargetKind {
  if (!isConversationalWorkflowName(name)) return "workflow";
  const projection = WorkflowProjectionDefinition(wireProjection);
  if (projection instanceof type.errors) return "workflow";
  const [stepId, ...rest] = projection.stepOrder;
  if (stepId === undefined || rest.length > 0) return "workflow";
  const step = type({ kind: "string" })(projection.steps[stepId]);
  return !(step instanceof type.errors) && step.kind === "step"
    ? "agent"
    : "workflow";
}

// Re-parsing the same frozen wire projection on every call/candidate/page
// is pure waste: the projection at one wire hash never changes once frozen.
// Keyed by wire hash so a definition retargeted to a new deploy recomputes.
const routineTargetKindCache = new Map<string, RoutineTargetKind>();

export function routineTargetKind(
  name: string,
  wireProjection: unknown,
  wireHash?: string,
): RoutineTargetKind {
  if (wireHash === undefined) {
    return computeRoutineTargetKind(name, wireProjection);
  }
  const cacheKey = `${name}:${wireHash}`;
  const cached = routineTargetKindCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const kind = computeRoutineTargetKind(name, wireProjection);
  routineTargetKindCache.set(cacheKey, kind);
  return kind;
}

function offeredAsRoutineTarget(name: string): boolean {
  if (isWorkbenchHostDefinitionName(name)) return false;
  return isAutomatableWorkflowName(name) || isConversationalWorkflowName(name);
}

export const ROUTINE_TARGETS_DEFAULT_LIMIT = 50;
export const ROUTINE_TARGETS_MAX_LIMIT = 200;

export type RoutineTargetsDeps = {
  readonly db: DB["db"];
  readonly grantStore: GrantStore;
  readonly conditionRegistry: ConditionRegistry;
};

export type RoutineTargetsQuery = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly limit: number;
  readonly cursor?: string | undefined;
};

export type RoutineTargetsPage = {
  readonly items: readonly RoutineTarget[];
  readonly nextCursor: string | null;
};

export class InvalidRoutineTargetCursorError extends Error {
  constructor() {
    super("The routine targets cursor is not one this listing issued.");
    this.name = "InvalidRoutineTargetCursorError";
  }
}

// Keyed on `assetName` (the stable catalog key), not the derived display
// `name` (which can shift when a definition's description changes) — a
// cursor built from a value that can move between two paginated requests
// would silently skip or duplicate rows across pages.
type CursorKey = { readonly assetName: string; readonly definitionAssetId: string };

const CursorKeySchema = type({
  assetName: "string",
  definitionAssetId: "string",
});

function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    // report-error-ignore: a malformed cursor is caller input, reported as 400 by the route
    throw new InvalidRoutineTargetCursorError();
  }
  const key = CursorKeySchema(parsed);
  if (key instanceof type.errors) throw new InvalidRoutineTargetCursorError();
  return key;
}

function compareKeys(a: CursorKey, b: CursorKey): number {
  if (a.assetName !== b.assetName) {
    return a.assetName < b.assetName ? -1 : 1;
  }
  if (a.definitionAssetId !== b.definitionAssetId) {
    return a.definitionAssetId < b.definitionAssetId ? -1 : 1;
  }
  return 0;
}

/**
 * Deployed, frozen definitions the acting principal may target from a
 * routine, ordered by `(name asc, definitionAssetId asc)` and paged by an
 * opaque cursor. Every candidate is authorized (`workflow-definition:<id>`
 * / `read`) before it is counted, sorted, or returned, so a denied row
 * never shapes the page a caller sees. Product filter: catalog
 * `automatable` workflows and conversational agents; workbench-host
 * anchors never appear.
 */
export async function listRoutineTargets(
  deps: RoutineTargetsDeps,
  query: RoutineTargetsQuery,
): Promise<RoutineTargetsPage> {
  const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const candidates = await listLaunchableDefinitions(deps.db, query.tenantId);
  const offered = candidates.filter((candidate) =>
    offeredAsRoutineTarget(candidate.name),
  );

  // One authorize call per candidate, in parallel rather than one await
  // per row serially — the row count this pays for is the same either
  // way, but a tenant with hundreds of definitions no longer pays it as
  // a strictly sequential round trip per row.
  const decisions = await Promise.all(
    offered.map((candidate) =>
      authorize(
        deps.grantStore,
        query.principalId,
        query.tenantId,
        `workflow-definition:${candidate.definitionId}`,
        "read",
        deps.conditionRegistry,
      ),
    ),
  );

  const visible: RoutineTarget[] = [];
  offered.forEach((candidate, index) => {
    const decision = decisions[index];
    if (decision === undefined || decision.effect !== "allow") return;
    visible.push({
      definitionAssetId: candidate.definitionAssetId,
      definitionId: candidate.definitionId,
      assetName: candidate.name,
      name: workflowDisplayName(candidate.name, candidate.description),
      description: candidate.description,
      kind: routineTargetKind(
        candidate.name,
        candidate.wireProjection,
        candidate.wireHash,
      ),
      wireHash: candidate.wireHash,
    });
  });

  visible.sort((a, b) =>
    compareKeys(
      { assetName: a.assetName, definitionAssetId: a.definitionAssetId },
      { assetName: b.assetName, definitionAssetId: b.definitionAssetId },
    ),
  );
  const remaining =
    after === null
      ? visible
      : visible.filter(
          (item) =>
            compareKeys(
              {
                assetName: item.assetName,
                definitionAssetId: item.definitionAssetId,
              },
              after,
            ) > 0,
        );
  const items = remaining.slice(0, query.limit);
  const last = items.at(-1);
  const nextCursor =
    remaining.length > items.length && last !== undefined
      ? encodeCursor({
          assetName: last.assetName,
          definitionAssetId: last.definitionAssetId,
        })
      : null;
  return { items, nextCursor };
}
