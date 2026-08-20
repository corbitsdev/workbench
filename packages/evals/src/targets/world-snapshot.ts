// Reads the tenant's actual state straight off the platform's own
// tables and stores — the same "read the platform's own tables
// directly" convention `./trace.ts` already established for tool
// calls, extended here to agent definitions, routines, and
// connections. A scorer that only ever saw the transcript could check
// what the agent *said/called*; this is what lets it check what
// actually exists afterward.
//
// Every read below mirrors a real, already-shipped read path instead
// of reinventing one:
//   - agent definitions: `@corbits/agent-directory`'s
//     `listVisibleAgentDefinitions` query shape, minus its DM-only
//     filtering (a world snapshot wants every deployed definition, not
//     just the conversational ones a sidebar would show), then
//     `readAgentCapabilities` on the definition its asset's source tree
//     carries, read back through `readAgentDefinitionWorkflowJson` —
//     the same pair `GET /:definitionId/capabilities` calls.
//   - routines: `routines.routine`, queried the same
//     `tenantId`/`deletedAt IS NULL` shape `RoutineStore.listRoutines`
//     uses.
//   - connections: `@workbench/connections`'
//     `listMcpServerConnections` verbatim — it already filters to an
//     active credential, so everything it returns is "live".
import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";
import {
  readAgentCapabilities,
  readAgentDefinitionWorkflowJson,
} from "@corbits/agent-directory";
import { routine as routineTable } from "@corbits/routines";
import { listMcpServerConnections } from "@workbench/connections";

import type { FakeReceipt, WorldSnapshot } from "../types.ts";

/** The infra `captureWorldSnapshot` reads through — a real `@intx/db`
 * drizzle handle and `AssetService`, the same two things
 * `agent-directory`'s own routes already depend on, so a caller
 * standing up a live target has both on hand already.
 * `fakeReceiptsReader` is gap 3's recording-MCP-fake feed: omitted (or
 * returning `[]`) when no fake is wired for the eval. */
export interface WorldSnapshotInfra {
  readonly db: DB["db"];
  readonly assetService: AssetService;
  readonly fakeReceiptsReader?: () => readonly FakeReceipt[];
}

async function readAgentDefinitions(
  db: DB["db"],
  assetService: AssetService,
  tenantId: string,
) {
  const rows = await db.query.workflowDefinition.findMany({
    where: and(
      eq(schema.workflowDefinition.tenantId, tenantId),
      eq(schema.workflowDefinition.status, "deployed"),
    ),
  });

  const deployable = rows.filter(
    (row): row is typeof row & { assetId: string } => row.assetId !== null,
  );
  return Promise.all(
    deployable.map(async (row) => {
      const workflowJson = await readAgentDefinitionWorkflowJson(
        assetService,
        row.assetId,
      );
      const capabilities = readAgentCapabilities(workflowJson);
      return {
        id: row.id,
        name: row.description ?? row.name,
        toolPackagePins: capabilities.toolPackagePins.map((pin) => pin.name),
        skills: [] as readonly string[],
        model: capabilities.model ?? null,
      };
    }),
  );
}

async function readRoutines(db: DB["db"], tenantId: string) {
  const rows = await db
    .select()
    .from(routineTable)
    .where(
      and(eq(routineTable.tenantId, tenantId), isNull(routineTable.deletedAt)),
    );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    definitionId: row.definitionId,
    trigger: row.trigger,
    deliveryWorkbenchId: row.deliveryWorkbenchId,
    enabled: row.enabled,
  }));
}

async function readConnections(db: DB["db"], tenantId: string) {
  const connections = await listMcpServerConnections(db, tenantId);
  return connections.map((connection) => ({
    slug: connection.slug,
    name: connection.name,
    url: connection.url,
    live: true,
  }));
}

/**
 * Captures everything a world-snapshot scorer can check about the
 * tenant right now: its deployed agent definitions (with tools/skills/
 * model), its routines (with trigger/delivery), its live connections,
 * and whatever a recording MCP fake has received so far. Read-only —
 * never mutates anything.
 */
export async function captureWorldSnapshot(
  infra: WorldSnapshotInfra,
  tenantId: string,
): Promise<WorldSnapshot> {
  const [agentDefinitions, routines, connections] = await Promise.all([
    readAgentDefinitions(infra.db, infra.assetService, tenantId),
    readRoutines(infra.db, tenantId),
    readConnections(infra.db, tenantId),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    agentDefinitions,
    routines,
    connections,
    fakeReceipts: infra.fakeReceiptsReader?.() ?? [],
  };
}
