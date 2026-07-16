import { describe, expect, it, mock } from "bun:test";
import { type } from "arktype";
import type { HubDb } from "../db";
import {
  MYRA_INSTRUCTIONS_MAX_LENGTH,
  MyraVariantPreferencePatchSchema,
  readMyraVariantPreference,
  setMyraVariantPreference,
  validateMyraVariantPatch,
} from "./myra-variant-preferences";

type StoredRow = {
  chatVariantId: string | null;
  triageVariantId: string | null;
  instructionsGlobal?: string | null;
  instructionsChat?: string | null;
  instructionsTriage?: string | null;
  personality?: string | null;
  emojiUse?: string | null;
  uiType?: string | null;
  artifactUsageChat?: string | null;
  artifactUsageTriage?: string | null;
  toolUsageChat?: string | null;
  toolUsageTriage?: string | null;
  skillUsageChat?: string | null;
  skillUsageTriage?: string | null;
};

function makeDb(opts: {
  stored?: StoredRow;
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

const EMPTY = {
  chat: null,
  triage: null,
  instructionsGlobal: null,
  instructionsChat: null,
  instructionsTriage: null,
  personality: null,
  emojiUse: null,
  uiType: null,
  artifactUsageChat: null,
  artifactUsageTriage: null,
  toolUsageChat: null,
  toolUsageTriage: null,
  skillUsageChat: null,
  skillUsageTriage: null,
};

describe("readMyraVariantPreference", () => {
  it("returns nulls when no row exists", async () => {
    const db = makeDb({ stored: undefined });
    expect(await readMyraVariantPreference(db, "tn", "prn")).toEqual(EMPTY);
  });

  it("returns the stored variant selection and instructions with default nulls on style axes", async () => {
    const db = makeDb({
      stored: {
        chatVariantId: "myra-opus-4-8",
        triageVariantId: null,
        instructionsGlobal: "Be terse.",
        instructionsChat: null,
        instructionsTriage: null,
      },
    });
    expect(await readMyraVariantPreference(db, "tn", "prn")).toEqual({
      ...EMPTY,
      chat: "myra-opus-4-8",
      instructionsGlobal: "Be terse.",
    });
  });

  it("returns stored style-axis selections", async () => {
    const db = makeDb({
      stored: {
        chatVariantId: null,
        triageVariantId: null,
        personality: "candid",
        emojiUse: "heavy",
        uiType: "paragraphs",
        artifactUsageChat: "heavy",
        artifactUsageTriage: "none",
        toolUsageChat: "light",
        toolUsageTriage: "none",
        skillUsageChat: "heavy",
        skillUsageTriage: "default",
      },
    });
    expect(await readMyraVariantPreference(db, "tn", "prn")).toEqual({
      ...EMPTY,
      personality: "candid",
      emojiUse: "heavy",
      uiType: "paragraphs",
      artifactUsageChat: "heavy",
      artifactUsageTriage: "none",
      toolUsageChat: "light",
      toolUsageTriage: "none",
      skillUsageChat: "heavy",
      skillUsageTriage: "default",
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

  it("accepts known style-axis option ids and null", () => {
    expect(
      validateMyraVariantPatch({
        personality: "candid",
        emojiUse: null,
        uiType: "paragraphs",
        artifactUsageChat: "heavy",
        artifactUsageTriage: "none",
        toolUsageChat: "light",
        toolUsageTriage: null,
        skillUsageChat: "default",
        skillUsageTriage: "heavy",
      }),
    ).toBeNull();
  });

  it("rejects an unknown style-axis option id", () => {
    expect(
      validateMyraVariantPatch({ personality: "not-a-real-option" }),
    ).toContain("not-a-real-option");
  });

  it("rejects a usage-axis option id given to the wrong axis", () => {
    // "teammate" is a personality option, not a usage-dial option.
    expect(
      validateMyraVariantPatch({ artifactUsageChat: "teammate" }),
    ).toContain("teammate");
  });
});

describe("setMyraVariantPreference", () => {
  it("merges only the provided axis, keeping the untouched one", async () => {
    const values = mock(() => ({
      onConflictDoUpdate: mock(() => Promise.resolve()),
    }));
    const db = makeDb({
      stored: {
        chatVariantId: "myra-kimi-k2-6",
        triageVariantId: null,
        instructionsGlobal: null,
        instructionsChat: null,
        instructionsTriage: null,
      },
      values,
    });

    const merged = await setMyraVariantPreference(db, "tn", "prn", {
      triage: "myra-triage-opus-4-8",
    });

    expect(merged).toEqual({
      ...EMPTY,
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
      stored: {
        chatVariantId: "myra-opus-4-8",
        triageVariantId: null,
        instructionsGlobal: null,
        instructionsChat: null,
        instructionsTriage: null,
      },
    });
    const merged = await setMyraVariantPreference(db, "tn", "prn", {
      chat: null,
    });
    expect(merged.chat).toBeNull();
  });

  it("merges only the provided instructions field, keeping others untouched", async () => {
    const db = makeDb({
      stored: {
        chatVariantId: null,
        triageVariantId: null,
        instructionsGlobal: "Be terse.",
        instructionsChat: "Use bullets.",
        instructionsTriage: null,
      },
    });

    const merged = await setMyraVariantPreference(db, "tn", "prn", {
      instructionsTriage: "Flag investor mail.",
    });

    expect(merged).toEqual({
      ...EMPTY,
      instructionsGlobal: "Be terse.",
      instructionsChat: "Use bullets.",
      instructionsTriage: "Flag investor mail.",
    });
  });

  it("clears an instructions field when the patch sets it to null", async () => {
    const db = makeDb({
      stored: {
        chatVariantId: null,
        triageVariantId: null,
        instructionsGlobal: "Be terse.",
        instructionsChat: null,
        instructionsTriage: null,
      },
    });
    const merged = await setMyraVariantPreference(db, "tn", "prn", {
      instructionsGlobal: null,
    });
    expect(merged.instructionsGlobal).toBeNull();
  });

  it("merges a style-axis patch while leaving other axes and variant selection untouched", async () => {
    const values = mock(() => ({
      onConflictDoUpdate: mock(() => Promise.resolve()),
    }));
    const db = makeDb({
      stored: {
        chatVariantId: "myra-opus-4-8",
        triageVariantId: null,
        personality: "friendly",
        artifactUsageChat: "heavy",
      },
      values,
    });

    const merged = await setMyraVariantPreference(db, "tn", "prn", {
      artifactUsageChat: "none",
      toolUsageTriage: "light",
    });

    expect(merged).toEqual({
      ...EMPTY,
      chat: "myra-opus-4-8",
      personality: "friendly",
      artifactUsageChat: "none",
      toolUsageTriage: "light",
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        personality: "friendly",
        artifactUsageChat: "none",
        toolUsageTriage: "light",
      }),
    );
  });

  it("round-trips instruction fields and style-axis fields through one call", async () => {
    // Rebase-merge guard: both features share this record and upsert — a
    // conflict resolution that drops either side's columns from .values() or
    // .onConflictDoUpdate().set() must fail here.
    const capturedValues: Record<string, unknown>[] = [];
    const capturedSets: Record<string, unknown>[] = [];
    const onConflictDoUpdate = mock((arg: { set: Record<string, unknown> }) => {
      capturedSets.push(arg.set);
      return Promise.resolve();
    });
    const values = mock((arg: Record<string, unknown>) => {
      capturedValues.push(arg);
      return { onConflictDoUpdate };
    });
    const db = makeDb({
      stored: {
        chatVariantId: null,
        triageVariantId: null,
        instructionsGlobal: "Be terse.",
        skillUsageTriage: "light",
      },
      values,
    });

    const merged = await setMyraVariantPreference(db, "tn", "prn", {
      instructionsChat: "Use bullets.",
      personality: "candid",
      toolUsageChat: "none",
    });

    expect(merged).toEqual({
      ...EMPTY,
      instructionsGlobal: "Be terse.",
      instructionsChat: "Use bullets.",
      personality: "candid",
      toolUsageChat: "none",
      skillUsageTriage: "light",
    });
    for (const persisted of [capturedValues[0], capturedSets[0]]) {
      expect(persisted).toMatchObject({
        instructionsGlobal: "Be terse.",
        instructionsChat: "Use bullets.",
        instructionsTriage: null,
        personality: "candid",
        toolUsageChat: "none",
        skillUsageTriage: "light",
      });
    }
  });
});

describe("MyraVariantPreferencePatchSchema length validation", () => {
  it("rejects an instructions field over the max length", () => {
    const tooLong = "a".repeat(MYRA_INSTRUCTIONS_MAX_LENGTH + 1);
    const result = MyraVariantPreferencePatchSchema({
      instructionsGlobal: tooLong,
    });
    expect(result instanceof type.errors).toBe(true);
  });

  it("accepts an instructions field at the max length, and null", () => {
    const atMax = "a".repeat(MYRA_INSTRUCTIONS_MAX_LENGTH);
    const result = MyraVariantPreferencePatchSchema({
      instructionsGlobal: atMax,
      instructionsChat: null,
    });
    expect(result instanceof type.errors).toBe(false);
  });
});
