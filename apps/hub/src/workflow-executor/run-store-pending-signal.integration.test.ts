import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { schema } from "../db";
import type { HubDb } from "../db";
import {
  applyRunProjection,
  insertRunRecord,
  loadRunRecord,
  refreshPendingSignalIfCurrent,
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

  test("the projection clears the pending signal once the log proves ITS signalId received", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p2" });
    await setPendingSignal(db, "wfr_p2", SIGNAL);

    await applyRunProjection(db, "wfr_p2", {
      status: "running",
      clearPendingSignal: { signalIds: [SIGNAL.signalId] },
    });

    const loaded = await loadRunRecord(db, "wfr_p2");
    expect(loaded?.pendingSignal).toBeUndefined();
    expect(loaded?.status).toBe("running");
  });

  test("a clear proven for an EARLIER signalId does not erase a newly-accepted pending signal (multi-gate interleave)", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p5" });
    // Gate N's signal was accepted, delivered, and its SignalReceived is
    // about to fold — but gate N+1's signal was accepted in the meantime.
    const gateN1 = { ...SIGNAL, signalId: "sig-2", signalName: "next-gate" };
    await setPendingSignal(db, "wfr_p5", gateN1);

    // The projection folds gate N's receipt (sig-1). The clear is
    // conditional IN SQL on the proven signalId, so a stale decision read
    // cannot erase sig-2 before its own delivery is proven.
    await applyRunProjection(db, "wfr_p5", {
      status: "awaiting",
      clearPendingSignal: { signalIds: ["sig-1"] },
    });

    const loaded = await loadRunRecord(db, "wfr_p5");
    expect(loaded?.pendingSignal).toEqual(gateN1);
  });

  test("a terminal projection clears any pending signal unconditionally (no further gate exists)", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p6" });
    await setPendingSignal(db, "wfr_p6", SIGNAL);

    await applyRunProjection(db, "wfr_p6", {
      status: "completed",
      clearPendingSignal: true,
    });

    const loaded = await loadRunRecord(db, "wfr_p6");
    expect(loaded?.pendingSignal).toBeUndefined();
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

  test("the re-delivery refresh updates the record only while ITS signalId is still current", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p7" });
    await setPendingSignal(db, "wfr_p7", SIGNAL);

    const refreshed = await refreshPendingSignalIfCurrent(db, "wfr_p7", {
      ...SIGNAL,
      receivedAt: "2026-07-09T01:00:00.000Z",
    });

    expect(refreshed).toBe(true);
    const loaded = await loadRunRecord(db, "wfr_p7");
    expect(loaded?.pendingSignal?.receivedAt).toBe("2026-07-09T01:00:00.000Z");
  });

  test("the re-delivery refresh cannot resurrect a record the projection just cleared", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p8" });
    await setPendingSignal(db, "wfr_p8", SIGNAL);
    // The projection proves receipt and clears between the reconciler's
    // decision read and its refresh.
    await applyRunProjection(db, "wfr_p8", {
      status: "running",
      clearPendingSignal: { signalIds: [SIGNAL.signalId] },
    });

    const refreshed = await refreshPendingSignalIfCurrent(db, "wfr_p8", {
      ...SIGNAL,
      receivedAt: "2026-07-09T01:00:00.000Z",
    });

    expect(refreshed).toBe(false);
    const loaded = await loadRunRecord(db, "wfr_p8");
    expect(loaded?.pendingSignal).toBeUndefined();
  });

  test("the re-delivery refresh does not clobber a NEWER pending signal accepted meanwhile", async () => {
    await insertRunRecord(db, { ...base, runId: "wfr_p9" });
    const newer = { ...SIGNAL, signalId: "sig-newer" };
    await setPendingSignal(db, "wfr_p9", newer);

    const refreshed = await refreshPendingSignalIfCurrent(db, "wfr_p9", {
      ...SIGNAL,
      receivedAt: "2026-07-09T01:00:00.000Z",
    });

    expect(refreshed).toBe(false);
    const loaded = await loadRunRecord(db, "wfr_p9");
    expect(loaded?.pendingSignal).toEqual(newer);
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
