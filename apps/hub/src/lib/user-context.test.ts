import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

const ROOT_TENANT = {
  slug: "acme",
  name: "Acme Inc",
  domain: "acme.example.com",
};

mock.module("../config", () => ({
  getConfig: () => ({ rootTenant: ROOT_TENANT }),
  loadConfig: () => ({ rootTenant: ROOT_TENANT }),
}));

import { getUserContext, getRequestedUserContext } from "./user-context";

const ROOT = { id: "tnt_root", slug: "acme" };
const SIBLING_A = "tnt_a";
const SIBLING_B = "tnt_b";
const USER_ID = "user-1";

/**
 * Build a mock DB whose tenant/principal `findFirst` honour the where-clause
 * the helper builds. Each `findFirst` receives the same drizzle `where`
 * structure; we cannot introspect it cheaply, so we drive behaviour off a
 * caller-supplied resolver per table.
 */
function makeDb(opts: {
  tenant?: () => Promise<unknown>;
  principal?: (call: number) => Promise<unknown>;
}): HubDb {
  let principalCalls = 0;
  return {
    query: {
      tenant: {
        findFirst: mock(opts.tenant ?? (() => Promise.resolve(ROOT))),
      },
      principal: {
        findFirst: mock(() => {
          const call = principalCalls++;
          return (opts.principal ?? (() => Promise.resolve(undefined)))(call);
        }),
      },
    },
  } as unknown as HubDb;
}

describe("getUserContext", () => {
  it("resolves the default home to the root tenant for a joined user", async () => {
    const db = makeDb({
      tenant: () => Promise.resolve(ROOT),
      principal: () => Promise.resolve({ id: "prn_root" }),
    });

    const ctx = await getUserContext(db, USER_ID);

    expect(ctx).toEqual({ tenantId: "tnt_root", principalId: "prn_root" });
  });

  it("returns null when the root tenant is not seeded", async () => {
    const db = makeDb({ tenant: () => Promise.resolve(undefined) });
    expect(await getUserContext(db, USER_ID)).toBeNull();
  });

  it("returns null when the user has no principal in the root tenant", async () => {
    const db = makeDb({
      tenant: () => Promise.resolve(ROOT),
      principal: () => Promise.resolve(undefined),
    });
    expect(await getUserContext(db, USER_ID)).toBeNull();
  });
});

describe("getRequestedUserContext — sibling isolation", () => {
  it("returns home when no tenant is requested", async () => {
    const db = makeDb({
      tenant: () => Promise.resolve(ROOT),
      principal: () => Promise.resolve({ id: "prn_root" }),
    });

    const { context, forbidden } = await getRequestedUserContext(db, USER_ID);

    expect(forbidden).toBe(false);
    expect(context).toEqual({ tenantId: "tnt_root", principalId: "prn_root" });
  });

  it("returns home when the requested tenant equals home", async () => {
    const db = makeDb({
      tenant: () => Promise.resolve(ROOT),
      principal: () => Promise.resolve({ id: "prn_root" }),
    });

    const { context, forbidden } = await getRequestedUserContext(
      db,
      USER_ID,
      "tnt_root",
    );

    expect(forbidden).toBe(false);
    expect(context?.tenantId).toBe("tnt_root");
  });

  it("forbids a sibling tenant the user is a principal of NOWHERE", async () => {
    // Home resolves (root principal), but the requested sibling B has no
    // principal for this user — the AC: no sideways chain-walk into a sibling.
    const db = makeDb({
      tenant: () => Promise.resolve(ROOT),
      principal: (call) =>
        // call 0: home lookup in root → found; call 1: sibling B → none.
        Promise.resolve(call === 0 ? { id: "prn_root" } : undefined),
    });

    const { context, forbidden } = await getRequestedUserContext(
      db,
      USER_ID,
      SIBLING_B,
    );

    expect(forbidden).toBe(true);
    expect(context).toBeNull();
  });

  it("resolving home queries the root tenant, never a sibling", async () => {
    // The DB holds a principal for this user in BOTH the root tenant and sibling
    // A. getUserContext (home) must scope its principal lookup to the root id —
    // if it ever queried sibling A it would return prn_sibling_a. The mock
    // returns a DIFFERENT principal per tenant by inspecting the where-clause, so
    // a regression that resolved home against the wrong tenant fails here.
    const principalByTenant: Record<string, { id: string }> = {
      tnt_root: { id: "prn_root" },
      [SIBLING_A]: { id: "prn_sibling_a" },
    };
    // The drizzle where-clause is a cyclic object graph; walk it (cycle-safe)
    // collecting every primitive value so we can find which tenant id the query
    // was actually scoped to.
    const collectValues = (root: unknown): Set<unknown> => {
      const found = new Set<unknown>();
      const seen = new Set<unknown>();
      const stack = [root];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === null) continue;
        if (typeof node === "object") {
          if (seen.has(node)) continue;
          seen.add(node);
          for (const v of Object.values(node as Record<string, unknown>)) {
            stack.push(v);
          }
        } else {
          found.add(node);
        }
      }
      return found;
    };
    const db = {
      query: {
        tenant: { findFirst: mock(() => Promise.resolve(ROOT)) },
        principal: {
          findFirst: mock((q: unknown) => {
            const values = collectValues(q);
            const tenantId = Object.keys(principalByTenant).find((t) =>
              values.has(t),
            );
            return Promise.resolve(
              tenantId ? principalByTenant[tenantId] : undefined,
            );
          }),
        },
      },
    } as unknown as HubDb;

    const ctx = await getUserContext(db, USER_ID);

    expect(ctx).toEqual({ tenantId: "tnt_root", principalId: "prn_root" });
  });

  it("grants a requested sibling when the user IS an active principal there", async () => {
    const db = makeDb({
      tenant: () => Promise.resolve(ROOT),
      principal: (call) =>
        Promise.resolve(
          call === 0 ? { id: "prn_root" } : { id: "prn_sibling_a" },
        ),
    });

    const { context, forbidden } = await getRequestedUserContext(
      db,
      USER_ID,
      SIBLING_A,
    );

    expect(forbidden).toBe(false);
    expect(context).toEqual({
      tenantId: SIBLING_A,
      principalId: "prn_sibling_a",
    });
  });
});
