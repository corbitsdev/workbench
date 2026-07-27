import { describe, expect, test } from "bun:test";
import type { HubDb } from "../db";
import { resolvePrincipalIdsByRefId } from "./tenant-member-routing";

type PrincipalRow = { id: string; refId: string };

function makeDb(rows: PrincipalRow[]): {
  db: HubDb;
  queries: { where: unknown }[];
} {
  const queries: { where: unknown }[] = [];
  const db = {
    query: {
      principal: {
        findMany: async (args: { where: unknown }) => {
          queries.push(args);
          return rows;
        },
      },
    },
  } as unknown as HubDb;
  return { db, queries };
}

describe("resolvePrincipalIdsByRefId", () => {
  test("maps each known refId to its principal id", async () => {
    const { db } = makeDb([
      { id: "prn_alex", refId: "alex" },
      { id: "prn_sam", refId: "sam" },
    ]);
    const map = await resolvePrincipalIdsByRefId(db, "ten_1", ["alex", "sam"]);
    expect([...map.entries()].sort()).toEqual([
      ["alex", "prn_alex"],
      ["sam", "prn_sam"],
    ]);
  });

  // The departed-member case: absence from the map is the signal the caller
  // turns into a skip-with-reason, so it must be absence and not a throw.
  test("omits a refId with no principal in this tenant", async () => {
    const { db } = makeDb([{ id: "prn_alex", refId: "alex" }]);
    const map = await resolvePrincipalIdsByRefId(db, "ten_1", [
      "alex",
      "departed",
    ]);
    expect(map.get("alex")).toBe("prn_alex");
    expect(map.has("departed")).toBe(false);
  });

  test("does not hit the database when there is nothing routable to look up", async () => {
    const { db, queries } = makeDb([{ id: "prn_alex", refId: "alex" }]);
    expect((await resolvePrincipalIdsByRefId(db, "ten_1", [])).size).toBe(0);
    expect((await resolvePrincipalIdsByRefId(db, "ten_1", ["  "])).size).toBe(
      0,
    );
    expect(queries).toEqual([]);
  });

  test("trims and de-duplicates before querying", async () => {
    const { db, queries } = makeDb([{ id: "prn_alex", refId: "alex" }]);
    const map = await resolvePrincipalIdsByRefId(db, "ten_1", [
      " alex ",
      "alex",
    ]);
    expect(map.get("alex")).toBe("prn_alex");
    expect(queries).toHaveLength(1);
  });
});
