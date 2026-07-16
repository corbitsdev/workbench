import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";
import { createMyraVariantsRouter } from "./myra-variants";

// The router runs the REAL preference service (validation against the real
// catalog is the behavior under test); only the DB is a structural fake.
function makeDb(opts: {
  stored?: {
    chatVariantId: string | null;
    triageVariantId: string | null;
    instructionsGlobal?: string | null;
    instructionsChat?: string | null;
    instructionsTriage?: string | null;
  };
  values?: ReturnType<typeof mock>;
}): HubDb {
  const values =
    opts.values ??
    mock(() => ({ onConflictDoUpdate: mock(() => Promise.resolve()) }));
  return {
    query: {
      myraVariantPreference: {
        findFirst: mock(async () => opts.stored),
      },
      principal: {
        findFirst: mock(async () => null),
      },
    },
    insert: mock(() => ({ values })),
  } as unknown as HubDb;
}

const EMPTY_INSTRUCTIONS = {
  instructionsGlobal: null,
  instructionsChat: null,
  instructionsTriage: null,
};

const EMPTY_STYLE_AXES = {
  personality: null,
  emojiUse: null,
  uiType: null,
  artifactUsageChat: null,
  artifactUsageTriage: null,
  toolUsageChat: null,
  toolUsageTriage: null,
  skillUsageChat: null,
  skillUsageTriage: null,
  pinnedSkillIds: [],
};

function wrapWithTenant(
  db: HubDb,
  ctx = { tenantId: "tn-global", principalId: "prn-member" },
): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenant" as never, { id: ctx.tenantId });
    c.set("principal" as never, { id: ctx.principalId });
    await next();
  });
  app.route("/", createMyraVariantsRouter(db) as unknown as Hono);
  return app;
}

describe("Myra variants router", () => {
  it("lists the real variant catalog with cost tiers", async () => {
    const app = wrapWithTenant(makeDb({}));
    const res = await app.request("/myra/variants");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      variants: { id: string; costTier: string; isDefault: boolean }[];
    };
    expect(body.variants.find((v) => v.id === "myra-opus-4-8")?.costTier).toBe(
      "premium",
    );
    const kimi = body.variants.find((v) => v.id === "myra-kimi-k2-6");
    expect(kimi?.costTier).toBe("standard");
    expect(kimi?.isDefault).toBe(false);
    const deepseek = body.variants.find(
      (v) => v.id === "myra-deepseek-v4-flash",
    );
    expect(deepseek?.isDefault).toBe(true);
  });

  it("lists the real style-axes catalog without leaking snippet text", async () => {
    const app = wrapWithTenant(makeDb({}));
    const res = await app.request("/myra/style-axes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      axes: {
        id: string;
        defaultOptionId: string;
        options: Record<string, unknown>[];
      }[];
    };
    const personality = body.axes.find((a) => a.id === "personality");
    expect(personality?.defaultOptionId).toBe("teammate");
    expect(personality?.options.some((o) => o["id"] === "candid")).toBe(true);
    for (const axis of body.axes) {
      for (const option of axis.options) {
        expect(option).not.toHaveProperty("snippet");
      }
    }
  });

  it("returns the caller's selection scoped to the resolved member", async () => {
    const findFirst = mock(async () => ({
      chatVariantId: "myra-opus-4-8",
      triageVariantId: null,
      instructionsGlobal: null,
      instructionsChat: null,
      instructionsTriage: null,
    }));
    const db = {
      query: {
        myraVariantPreference: { findFirst },
        principal: { findFirst: mock(async () => null) },
      },
    } as unknown as HubDb;
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chat: "myra-opus-4-8",
      triage: null,
      ...EMPTY_INSTRUCTIONS,
      ...EMPTY_STYLE_AXES,
    });
  });

  it("returns stored style-axis selections alongside the variant selection", async () => {
    const findFirst = mock(async () => ({
      chatVariantId: null,
      triageVariantId: null,
      personality: "candid",
      emojiUse: null,
      uiType: null,
      artifactUsageChat: "none",
      artifactUsageTriage: null,
      toolUsageChat: null,
      toolUsageTriage: null,
      skillUsageChat: null,
      skillUsageTriage: null,
    }));
    const db = {
      query: {
        myraVariantPreference: { findFirst },
        principal: { findFirst: mock(async () => null) },
      },
    } as unknown as HubDb;
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chat: null,
      triage: null,
      ...EMPTY_INSTRUCTIONS,
      ...EMPTY_STYLE_AXES,
      personality: "candid",
      artifactUsageChat: "none",
    });
  });

  it("persists a valid selection, merging with the stored one", async () => {
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
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ triage: "myra-triage-opus-4-8" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chat: "myra-kimi-k2-6",
      triage: "myra-triage-opus-4-8",
      ...EMPTY_INSTRUCTIONS,
      ...EMPTY_STYLE_AXES,
    });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tn-global",
        memberPrincipalId: "prn-member",
        chatVariantId: "myra-kimi-k2-6",
        triageVariantId: "myra-triage-opus-4-8",
      }),
    );
  });

  it("persists standing instructions fields, merging with the stored ones", async () => {
    const values = mock(() => ({
      onConflictDoUpdate: mock(() => Promise.resolve()),
    }));
    const db = makeDb({
      stored: {
        chatVariantId: null,
        triageVariantId: null,
        instructionsGlobal: "Be terse.",
        instructionsChat: null,
        instructionsTriage: null,
      },
      values,
    });
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructionsTriage: "Flag investor mail." }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chat: null,
      triage: null,
      ...EMPTY_STYLE_AXES,
      instructionsGlobal: "Be terse.",
      instructionsChat: null,
      instructionsTriage: "Flag investor mail.",
    });
  });

  it("400s an instructions field over the max length without touching the DB", async () => {
    const values = mock(() => ({
      onConflictDoUpdate: mock(() => Promise.resolve()),
    }));
    const db = makeDb({ values });
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructionsGlobal: "a".repeat(4001) }),
    });
    expect(res.status).toBe(400);
    expect(values).not.toHaveBeenCalled();
  });

  it("400s an unknown variant id without touching the DB", async () => {
    const values = mock(() => ({
      onConflictDoUpdate: mock(() => Promise.resolve()),
    }));
    const db = makeDb({ values });
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat: "not-a-variant" }),
    });
    expect(res.status).toBe(400);
    expect(values).not.toHaveBeenCalled();
  });

  it("400s a triage id on the chat axis (wrong kind)", async () => {
    const db = makeDb({});
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat: "myra-triage-opus-4-8" }),
    });
    expect(res.status).toBe(400);
  });

  it("persists a valid style-axis selection", async () => {
    const values = mock(() => ({
      onConflictDoUpdate: mock(() => Promise.resolve()),
    }));
    const db = makeDb({ values });
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personality: "candid", toolUsageChat: "none" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      chat: null,
      triage: null,
      ...EMPTY_INSTRUCTIONS,
      ...EMPTY_STYLE_AXES,
      personality: "candid",
      toolUsageChat: "none",
    });
  });

  it("400s an unknown style-axis option id without touching the DB", async () => {
    const values = mock(() => ({
      onConflictDoUpdate: mock(() => Promise.resolve()),
    }));
    const db = makeDb({ values });
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personality: "not-a-real-option" }),
    });
    expect(res.status).toBe(400);
    expect(values).not.toHaveBeenCalled();
  });
});
