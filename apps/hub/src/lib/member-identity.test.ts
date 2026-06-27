/// <reference types="bun" />
import { describe, expect, it, mock } from "bun:test";
import { getIdentityAccounts, setIdentityAccount } from "./member-identity";

type Row = Record<string, unknown>;

// Tailored drizzle mock. `selectRows` is what a get() select resolves to;
// `returnRow` is what the set() upsert returns. Captures the update (primary
// clear) and the inserted values so a test can assert real branch behavior.
function makeDb(opts: { selectRows?: Row[]; returnRow?: Row }) {
  const updates: Row[] = [];
  const inserted: Row[] = [];

  const tx = {
    update: mock(() => ({
      set: mock((v: Row) => {
        updates.push(v);
        return { where: () => Promise.resolve() };
      }),
    })),
    insert: mock(() => ({
      values: mock((v: Row) => {
        inserted.push(v);
        return {
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([opts.returnRow ?? {}]),
          }),
        };
      }),
    })),
  };

  const db = {
    select: mock(() => ({
      from: () => ({ where: () => Promise.resolve(opts.selectRows ?? []) }),
    })),
    transaction: mock((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { db, updates, inserted };
}

describe("getIdentityAccounts", () => {
  it("sorts accounts by provider, then primary first, and defaults null metadata to {}", async () => {
    const { db } = makeDb({
      selectRows: [
        {
          provider: "linear",
          value: "b",
          label: null,
          isPrimary: false,
          metadata: {},
        },
        {
          provider: "linear",
          value: "a",
          label: "A",
          isPrimary: true,
          metadata: { workspace: "acme" },
        },
        {
          provider: "attio",
          value: "x",
          label: null,
          isPrimary: false,
          metadata: null,
        },
      ],
    });

    const accounts = await getIdentityAccounts(db as never, "tnt", "mem");
    expect(accounts.map((a) => `${a.provider}:${a.value}`)).toEqual([
      "attio:x",
      "linear:a",
      "linear:b",
    ]);
    // Primary sorts ahead of non-primary within linear.
    expect(accounts[1]!.isPrimary).toBe(true);
    // Null metadata is normalized to an object.
    expect(accounts[0]!.metadata).toEqual({});
  });
});

describe("setIdentityAccount", () => {
  it("clears other primaries for the provider when primary is set", async () => {
    const { db, updates, inserted } = makeDb({
      returnRow: {
        provider: "linear",
        value: "u1",
        label: "Work",
        isPrimary: true,
        metadata: {},
      },
    });

    const result = await setIdentityAccount(db as never, "tnt", "mem", {
      provider: "linear",
      value: "u1",
      label: "Work",
      primary: true,
    });

    // The primary-clear update ran, and the new row is marked primary.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.isPrimary).toBe(false);
    expect(inserted[0]!.isPrimary).toBe(true);
    expect(result.isPrimary).toBe(true);
  });

  it("does not clear primaries when primary is not set", async () => {
    const { db, updates, inserted } = makeDb({
      returnRow: {
        provider: "linear",
        value: "u2",
        label: null,
        isPrimary: false,
        metadata: {},
      },
    });

    await setIdentityAccount(db as never, "tnt", "mem", {
      provider: "linear",
      value: "u2",
    });

    expect(updates).toHaveLength(0);
    expect(inserted[0]!.isPrimary).toBe(false);
  });
});
