import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";
import {
  readMyraVariantPreference,
  setMyraVariantPreference,
  validateMyraVariantPatch,
} from "./myra-variant-preferences";

function makeDb(opts: {
  stored?: { chatVariantId: string | null; triageVariantId: string | null };
  onConflictDoUpdate?: ReturnType<typeof mock>;
  values?: ReturnType<typeof mock>;
}): HubDb {
  const onConflictDoUpdate =
    opts.onConflictDoUpdate ?? mock(() => Promise.resolve());
  const values = opts.values ?? mock(() => ({ onConflictDoUpdate }));
  return {
    query: {
      myraVariantPreference: {
        findFirst: mock(async () => opts.stored),
      },
    },
    insert: mock(() => ({ values })),
  } as unknown as HubDb;
}

describe("readMyraVariantPreference", () => {
  it("returns nulls when no row exists", async () => {
    const db = makeDb({ stored: undefined });
    expect(await readMyraVariantPreference(db, "tn", "prn")).toEqual({
      chat: null,
      triage: null,
    });
  });

  it("returns the stored selection", async () => {
    const db = makeDb({
      stored: {
        chatVariantId: "myra-opus-4-8",
        triageVariantId: null,
      },
    });
    expect(await readMyraVariantPreference(db, "tn", "prn")).toEqual({
      chat: "myra-opus-4-8",
      triage: null,
    });
  });
});

describe("validateMyraVariantPatch", () => {
  it("accepts known ids of the right kind and null", () => {
    expect(
      validateMyraVariantPatch({ chat: "myra-opus-4-8", triage: null }),
    ).toBeNull();
    expect(validateMyraVariantPatch({})).toBeNull();
    expect(
      validateMyraVariantPatch({ triage: "myra-triage-kimi-k2-6" }),
    ).toBeNull();
  });

  it("rejects an unknown chat id", () => {
    expect(validateMyraVariantPatch({ chat: "nope" })).toContain("nope");
  });

  it("rejects a triage id used on the chat axis (wrong kind)", () => {
    expect(
      validateMyraVariantPatch({ chat: "myra-triage-opus-4-8" }),
    ).toContain("myra-triage-opus-4-8");
  });

  it("rejects a chat id used on the triage axis (wrong kind)", () => {
    expect(validateMyraVariantPatch({ triage: "myra-opus-4-8" })).toContain(
      "myra-opus-4-8",
    );
  });
});

describe("setMyraVariantPreference", () => {
  it("merges only the provided axis, keeping the untouched one", async () => {
    const values = mock(() => ({
      onConflictDoUpdate: mock(() => Promise.resolve()),
    }));
    const db = makeDb({
      stored: { chatVariantId: "myra-kimi-k2-6", triageVariantId: null },
      values,
    });

    const merged = await setMyraVariantPreference(db, "tn", "prn", {
      triage: "myra-triage-opus-4-8",
    });

    expect(merged).toEqual({
      chat: "myra-kimi-k2-6",
      triage: "myra-triage-opus-4-8",
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tn",
        memberPrincipalId: "prn",
        chatVariantId: "myra-kimi-k2-6",
        triageVariantId: "myra-triage-opus-4-8",
      }),
    );
  });

  it("clears an axis when the patch sets it to null", async () => {
    const db = makeDb({
      stored: { chatVariantId: "myra-opus-4-8", triageVariantId: null },
    });
    const merged = await setMyraVariantPreference(db, "tn", "prn", {
      chat: null,
    });
    expect(merged.chat).toBeNull();
  });
});
