import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";
import { createMyraVariantsRouter } from "./myra-variants";

// The router runs the REAL preference service (validation against the real
// catalog is the behavior under test); only the DB is a structural fake.
function makeDb(opts: {
  stored?: { chatVariantId: string | null; triageVariantId: string | null };
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
    },
    insert: mock(() => ({ values })),
  } as unknown as HubDb;
}

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
    expect(kimi?.isDefault).toBe(true);
  });

  it("returns the caller's selection scoped to the resolved member", async () => {
    const findFirst = mock(async () => ({
      chatVariantId: "myra-opus-4-8",
      triageVariantId: null,
    }));
    const db = {
      query: { myraVariantPreference: { findFirst } },
    } as unknown as HubDb;
    const app = wrapWithTenant(db);
    const res = await app.request("/members/me/myra-preferences");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chat: "myra-opus-4-8", triage: null });
  });

  it("persists a valid selection, merging with the stored one", async () => {
    const values = mock(() => ({
      onConflictDoUpdate: mock(() => Promise.resolve()),
    }));
    const db = makeDb({
      stored: { chatVariantId: "myra-kimi-k2-6", triageVariantId: null },
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
});
