import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import type { TimelineEntry } from "@workbench/timeline";

import { schema } from "../db";
import type { HubDb } from "../db";
import { getPrincipalActivityPage } from "./principal-activity";

const TENANT = "tn-us";
const PRINCIPAL = "prn-us";

let client: PGlite;
let db: HubDb;

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

async function seedSession(id: string, createdAt: string): Promise<void> {
  await client.query(
    `insert into agent_session (id, tenant_id, agent_id, principal_id, status, created_at, updated_at)
     values ($1, $2, 'agt-x', $3, 'active', $4, $4)`,
    [id, TENANT, PRINCIPAL, createdAt],
  );
}

describe("cursor with microsecond timestamps (hub stamps created_at via now())", () => {
  test("no rows dropped when timestamps carry microseconds", async () => {
    // Descending page order: s4, s3, s2, s1. Page size 2.
    // Boundary row s3 has ts ...00.123456 — toISOString() truncates to .123.
    await seedSession("us-s1", "2026-07-01T10:00:00.123123Z");
    await seedSession("us-s2", "2026-07-01T10:00:00.123400Z");
    await seedSession("us-s3", "2026-07-01T10:00:00.123456Z");
    await seedSession("us-s4", "2026-07-01T10:00:01Z");

    const paged: TimelineEntry[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const result = await getPrincipalActivityPage({
        db,
        tenantId: TENANT,
        principalId: PRINCIPAL,
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      paged.push(...result.entries);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect(paged.map((e) => e.id).sort()).toEqual([
      "us-s1",
      "us-s2",
      "us-s3",
      "us-s4",
    ]);
  });
});
