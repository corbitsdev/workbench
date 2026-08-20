// Proves `createWorkflowRunAuthenticator`'s two-factor check: a known
// sidecar token AND a resolvable run address are both required, and
// either one missing rejects the call. Matches the fake-`db` convention
// `packages/chat/test/chat-orchestrator.test.ts` uses for
// `findFoldedRunByAddress` — the `where` filter is not simulated, the
// fake just returns whatever row the test configured.
import { describe, expect, test } from "bun:test";

import { createWorkflowRunAuthenticator } from "./workflow-auth";

function fakeDb(opts: {
  sidecarRow?: { id: string };
  run?: { id: string; tenantId: string; principalId: string | null };
}) {
  return {
    query: {
      sidecar: {
        findFirst: async () => opts.sidecarRow,
      },
      workflowRun: {
        findFirst: async () => opts.run,
      },
    },
  } as unknown as Parameters<typeof createWorkflowRunAuthenticator>[0]["db"];
}

describe("createWorkflowRunAuthenticator", () => {
  test("resolves tenant/principal/run when both the token and the run address check out", async () => {
    const authenticator = createWorkflowRunAuthenticator({
      db: fakeDb({
        sidecarRow: { id: "sc_1" },
        run: { id: "run_1", tenantId: "ten_1", principalId: "prn_1" },
      }),
    });

    const resolved = await authenticator.resolve(
      "real-token",
      "run_1@workflow",
    );

    expect(resolved).toEqual({
      tenantId: "ten_1",
      principalId: "prn_1",
      runId: "run_1",
    });
  });

  test("rejects when the token hashes to no known sidecar", async () => {
    const authenticator = createWorkflowRunAuthenticator({
      db: fakeDb({
        run: { id: "run_1", tenantId: "ten_1", principalId: "prn_1" },
      }),
    });

    expect(
      await authenticator.resolve("unknown-token", "run_1@workflow"),
    ).toBeNull();
  });

  test("rejects when the run address resolves to no folded run", async () => {
    const authenticator = createWorkflowRunAuthenticator({
      db: fakeDb({ sidecarRow: { id: "sc_1" } }),
    });

    expect(
      await authenticator.resolve("real-token", "unknown@workflow"),
    ).toBeNull();
  });

  test("rejects a run with no principal — nothing to scope the write to", async () => {
    const authenticator = createWorkflowRunAuthenticator({
      db: fakeDb({
        sidecarRow: { id: "sc_1" },
        run: { id: "run_1", tenantId: "ten_1", principalId: null },
      }),
    });

    expect(
      await authenticator.resolve("real-token", "run_1@workflow"),
    ).toBeNull();
  });

  test("rejects an empty token or address without querying the db", async () => {
    const authenticator = createWorkflowRunAuthenticator({
      db: fakeDb({}),
    });

    expect(await authenticator.resolve("", "run_1@workflow")).toBeNull();
    expect(await authenticator.resolve("real-token", "")).toBeNull();
  });
});
