// The address→run mapping's own behavior: that a room address and a
// live deployment address both resolve to the same participant once
// they have come apart, and that "this run is dead" is told apart from
// "this folded run is parked between messages".
import { describe, expect, test } from "bun:test";
import {
  isBeyondWake,
  readBindingByAddress,
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
  noopInference: boolean;
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
function fakeDb(rows: LaunchRow[], foldedRunMarkerIds: string[] = []) {
  function matchingValue(where: unknown): string | undefined {
    const chunks = (where as { queryChunks?: unknown[] }).queryChunks ?? [];
    for (const chunk of chunks) {
      const value = (chunk as { value?: unknown }).value;
      if (typeof value === "string") return value;
    }
    return undefined;
  }
  return {
    select: (columns?: Record<string, unknown>) => ({
      from: () => ({
        where: (predicate: unknown) => ({
          limit: async () => {
            const value = matchingValue(predicate);
            if (columns !== undefined) {
              // `isFoldedRunSettled`'s marker probe.
              return foldedRunMarkerIds.includes(value ?? "")
                ? [{ id: value }]
                : [];
            }
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
  noopInference: false,
};

describe("readBindingByAddress", () => {
  test("resolves the room's own address to the run that is live now", async () => {
    const binding = await readBindingByAddress(
      fakeDb([relaunched]),
      "run_original@acme.example",
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
    );
    expect(binding?.roomAddress).toBe("run_original@acme.example");
  });

  test("is undefined for an address this package never launched", async () => {
    expect(
      await readBindingByAddress(fakeDb([relaunched]), "echo_1@acme.example"),
    ).toBeUndefined();
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
      await isBeyondWake(fakeDb([], ["run_fresh"]), {
        id: "run_fresh",
        status: "failed",
      }),
    ).toBe(true);
  });

  test("a running run is not", async () => {
    expect(
      await isBeyondWake(fakeDb([], ["run_fresh"]), {
        id: "run_fresh",
        status: "running",
      }),
    ).toBe(false);
  });

  test("a folded run parked between messages is not — that one wakes", async () => {
    expect(
      await isBeyondWake(fakeDb([], ["run_fresh"]), {
        id: "run_fresh",
        status: "completed",
      }),
    ).toBe(false);
  });

  test("a plain deployment's genuine completion IS beyond waking", async () => {
    // "completed" with no `folded_run` marker is a one-shot deployment
    // that is done forever, not an idle conversational run.
    expect(
      await isBeyondWake(fakeDb([], []), {
        id: "run_oneshot",
        status: "completed",
      }),
    ).toBe(true);
  });
});
