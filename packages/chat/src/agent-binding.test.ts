// The address→run mapping's own behavior: a room address and a live
// deployment address both resolve to the same participant once they
// have come apart, and a terminal `workflow_run` cannot be woken.
import { describe, expect, test } from "bun:test";
import {
  isBeyondWake,
  readBindingByAddress,
  readBindingByAddressAnyTenant,
  resolveRoomAddress,
} from "./agent-binding";

const FOLDED_BODY = {
  systemPrompt: "be helpful",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: null,
};

type LaunchRow = {
  tenantId: string;
  instanceId: string;
  currentRunId: string;
  priorRunIds: string[];
  foldedBody: unknown;
};

/**
 * Honours the `where` filter, unlike this package's older fakes: the
 * whole point of these cases is which COLUMN a lookup matched on, so a
 * filter-ignoring double would pass them vacuously. `readLaunchRow`
 * builds its filter with drizzle's `eq`, whose serialized form carries
 * the compared value in `queryChunks`; matching on the value alone is
 * enough here because no scenario has one id appearing in two columns
 * of different rows.
 */
function fakeDb(rows: LaunchRow[]) {
  function matchingValue(where: unknown): string | undefined {
    const chunks = (where as { queryChunks?: unknown[] }).queryChunks ?? [];
    for (const chunk of chunks) {
      const value = (chunk as { value?: unknown }).value;
      if (typeof value === "string") return value;
    }
    return undefined;
  }
  return {
    select: () => ({
      from: () => ({
        where: (predicate: unknown) => ({
          limit: async () => {
            const value = matchingValue(predicate);
            return rows.filter(
              (row) => row.instanceId === value || row.currentRunId === value,
            );
          },
        }),
      }),
    }),
  } as never;
}

const relaunched: LaunchRow = {
  tenantId: "ten_1",
  instanceId: "run_original",
  currentRunId: "run_fresh",
  priorRunIds: ["run_original"],
  foldedBody: FOLDED_BODY,
};

describe("readBindingByAddress", () => {
  test("resolves the room's own address to the run that is live now", async () => {
    const binding = await readBindingByAddress(
      fakeDb([relaunched]),
      "run_original@acme.example",
      "ten_1",
    );
    expect(binding?.stableId).toBe("run_original");
    expect(binding?.currentRunId).toBe("run_fresh");
    expect(binding?.roomAddress).toBe("run_original@acme.example");
    expect(binding?.liveAddress).toBe("run_fresh@acme.example");
  });

  test("resolves the live deployment address back to the same participant", async () => {
    // This is the inbound half: a relaunched run announces itself under
    // an address the room has never seen, and its reply still has to
    // land in the room that has been addressing it as `run_original`.
    const binding = await readBindingByAddress(
      fakeDb([relaunched]),
      "run_fresh@acme.example",
      "ten_1",
    );
    expect(binding?.roomAddress).toBe("run_original@acme.example");
  });

  test("is undefined for an address this package never launched", async () => {
    expect(
      await readBindingByAddress(
        fakeDb([relaunched]),
        "echo_1@acme.example",
        "ten_1",
      ),
    ).toBeUndefined();
  });
});

describe("readBindingByAddress: tenant scoping (CL-7474)", () => {
  // Two tenants that each independently invited "the same" agent
  // (definitionId happens to differ per tenant in practice, but the
  // launch rows below are shaped exactly like two independent
  // launches — different stable ids, different run ids, different
  // tenants). `instanceId`/`currentRunId` are collision-resistant
  // generated ids, not scoped to a tenant, so nothing but an explicit
  // `expectedTenantId` check stops tenant B's caller from resolving
  // tenant A's row if it ever guessed or replayed tenant A's address.
  const tenantALaunch: LaunchRow = {
    tenantId: "tnt_a",
    instanceId: "run_a1",
    currentRunId: "run_a1",
    priorRunIds: [],
    foldedBody: FOLDED_BODY,
  };
  const tenantBLaunch: LaunchRow = {
    tenantId: "tnt_b",
    instanceId: "run_b1",
    currentRunId: "run_b1",
    priorRunIds: [],
    foldedBody: FOLDED_BODY,
  };
  const db = fakeDb([tenantALaunch, tenantBLaunch]);

  test("each tenant's DM resolves to its own distinct run id and address", async () => {
    const a = await readBindingByAddress(db, "run_a1@acme.example", "tnt_a");
    const b = await readBindingByAddress(db, "run_b1@acme.example", "tnt_b");
    expect(a?.currentRunId).toBe("run_a1");
    expect(b?.currentRunId).toBe("run_b1");
    expect(a?.currentRunId).not.toBe(b?.currentRunId);
    expect(a?.roomAddress).not.toBe(b?.roomAddress);
  });

  test("a bench invite in tenant B never resolves tenant A's launch", async () => {
    expect(
      await readBindingByAddress(db, "run_a1@acme.example", "tnt_b"),
    ).toBeUndefined();
    expect(
      await readBindingByAddress(db, "run_b1@acme.example", "tnt_a"),
    ).toBeUndefined();
  });

});

describe("readBindingByAddressAnyTenant", () => {
  test("the address-only resolution event-stream discovery needs, with no tenant to check against", async () => {
    const anyTenantDb = fakeDb([
      { ...relaunched, instanceId: "run_a1", currentRunId: "run_a1" },
    ]);
    expect(
      (await readBindingByAddressAnyTenant(anyTenantDb, "run_a1@acme.example"))
        ?.tenantId,
    ).toBe("ten_1");
  });
});

describe("resolveRoomAddress", () => {
  test("leaves a non-participant address alone", async () => {
    expect(
      await resolveRoomAddress(fakeDb([relaunched]), "echo_1@acme.example"),
    ).toBe("echo_1@acme.example");
  });
});

describe("isBeyondWake", () => {
  test("a failed run is beyond waking — its durable log is already terminal", async () => {
    expect(
      await isBeyondWake(fakeDb([]), {
        id: "run_fresh",
        status: "failed",
      }),
    ).toBe(true);
  });

  test("a running run is not", async () => {
    expect(
      await isBeyondWake(fakeDb([]), {
        id: "run_fresh",
        status: "running",
      }),
    ).toBe(false);
  });

  test("a completed run is beyond waking — wake is a fresh provision", async () => {
    expect(
      await isBeyondWake(fakeDb([]), {
        id: "run_done",
        status: "completed",
      }),
    ).toBe(true);
  });
});
