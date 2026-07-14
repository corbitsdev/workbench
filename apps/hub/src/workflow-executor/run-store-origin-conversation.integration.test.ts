import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { schema } from "../db";
import type { HubDb } from "../db";
import { insertRunRecord, listRunRecords, loadRunRecord } from "./run-store";

// Real (PGlite) round-trip for the CL-2677 origin tag: the run record persists
// the conversation a run was started from, direct-started runs carry NULL, and
// the list read exposes and filters by it. Exercises the actual drizzle
// insert/select path — not a mock of the store.
const DDL = `
  CREATE TABLE workflow_run_record (
    id text PRIMARY KEY,
    deployment_id text,
    kind text NOT NULL,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    input jsonb,
    origin_conversation_id text,
    trigger_source text,
    pending_signal jsonb,
    started_at timestamp,
    ended_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    deleted_at timestamp
  );
`;

let client: PGlite;
let db: HubDb;

beforeEach(async () => {
  client = new PGlite();
  await client.exec(DDL);
  db = drizzle(client, { schema }) as unknown as HubDb;
});

afterEach(async () => {
  await client.close();
});

const base = {
  deploymentId: "ses_dep1",
  kind: "pain-point-collateral",
  tenantId: "tn-1",
  principalId: "prn-1",
  input: {},
};

describe("run record originConversationId (CL-2677)", () => {
  test("persists the origin conversation when provided and round-trips through load", async () => {
    const inserted = await insertRunRecord(db, {
      ...base,
      runId: "wfr_chat",
      originConversationId: "conv-42",
    });
    expect(inserted.originConversationId).toBe("conv-42");

    const loaded = await loadRunRecord(db, "wfr_chat");
    expect(loaded?.originConversationId).toBe("conv-42");
  });

  test("a direct-started run (no chat context) persists NULL and reads back without the field", async () => {
    await insertRunRecord(db, {
      ...base,
      runId: "wfr_direct",
      originConversationId: null,
    });

    const loaded = await loadRunRecord(db, "wfr_direct");
    expect(loaded).not.toBeNull();
    expect(loaded?.originConversationId).toBeUndefined();
  });

  test("list exposes the origin on each row and filters to a single conversation's runs", async () => {
    await insertRunRecord(db, {
      ...base,
      runId: "wfr_a",
      originConversationId: "conv-A",
    });
    await insertRunRecord(db, {
      ...base,
      runId: "wfr_b",
      originConversationId: "conv-B",
    });
    await insertRunRecord(db, {
      ...base,
      runId: "wfr_none",
      originConversationId: null,
    });

    const all = await listRunRecords(db, ["tn-1"], "prn-1");
    expect(all).toHaveLength(3);
    const byId = new Map(all.map((r) => [r.runId, r.originConversationId]));
    expect(byId.get("wfr_a")).toBe("conv-A");
    expect(byId.get("wfr_b")).toBe("conv-B");
    expect(byId.get("wfr_none")).toBeNull();

    const filtered = await listRunRecords(db, ["tn-1"], "prn-1", undefined, {
      originConversationId: "conv-A",
    });
    expect(filtered.map((r) => r.runId)).toEqual(["wfr_a"]);
  });
});
