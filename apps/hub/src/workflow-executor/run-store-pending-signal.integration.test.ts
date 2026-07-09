import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { schema } from "../db";
import type { HubDb } from "../db";
import {
  applyRunProjection,
  insertRunRecord,
  loadRunRecord,
  setPendingSignal,
} from "./run-store";

// Real (PGlite) round-trip for the pending-signal record that makes a
// 202-accepted gate signal durable: persisted before dispatch, carried on the
// run record while in flight, and cleared by the projection once the log
// proves the signal was received (or the run left the gate). Exercises the
// actual drizzle write/read path — not a mock of the store.
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
  originConversationId: null,
};

const SIGNAL = {
  signalId: "sig-1",
  signalName: "approval",
  payload: { approved: true },
  receivedAt: "2026-07-09T00:00:00.000Z",
};

describe("pending gate-signal record", () => {
  test("setPendingSignal persists the accepted signal and it round-trips through load", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p1" });
    await setPendingSignal(db, "wfr_p1", SIGNAL);

    const loaded = await loadRunRecord(db, "wfr_p1");
    expect(loaded?.pendingSignal).toEqual(SIGNAL);
  });

  test("the projection clears the pending signal once the log shows it received", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p2" });
    await setPendingSignal(db, "wfr_p2", SIGNAL);

    await applyRunProjection(db, "wfr_p2", {
      status: "running",
      clearPendingSignal: true,
    });

    const loaded = await loadRunRecord(db, "wfr_p2");
    expect(loaded?.pendingSignal).toBeUndefined();
    expect(loaded?.status).toBe("running");
  });

  test("a projection write without the clear flag preserves an in-flight pending signal", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p3" });
    await setPendingSignal(db, "wfr_p3", SIGNAL);

    // A pack lands (e.g. an unrelated step event) while the signal is still
    // in flight for a later gate: the pending record must survive.
    await applyRunProjection(db, "wfr_p3", { status: "awaiting" });

    const loaded = await loadRunRecord(db, "wfr_p3");
    expect(loaded?.pendingSignal).toEqual(SIGNAL);
  });

  test("re-signaling replaces the pending record (last accepted signal wins)", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p4" });
    await setPendingSignal(db, "wfr_p4", SIGNAL);
    const second = { ...SIGNAL, signalId: "sig-2" };
    await setPendingSignal(db, "wfr_p4", second);

    const loaded = await loadRunRecord(db, "wfr_p4");
    expect(loaded?.pendingSignal).toEqual(second);
  });
});
