import { describe, expect, it, mock } from "bun:test";

const resolveModelSources = mock(
  async (
    _db: unknown,
    _tenantId: string,
    requirements: { model: string }[],
  ) => {
    const model = requirements[0]?.model ?? "";
    if (model.includes("deepseek")) {
      return { ok: true as const, sources: [{ model }] };
    }
    return { ok: false as const, reason: "no_offerings" as const };
  },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports -- bun mock.module
const intxDb = require("@intx/db") as typeof import("@intx/db");
mock.module("@intx/db", () => ({
  ...intxDb,
  resolveModelSources,
}));

import {
  isMyraVariantAvailableForTenant,
  listAvailableMyraVariants,
  resolveLaunchableMyraVariant,
  softNullUnavailableVariantSelections,
} from "./myra-variant-availability";
import type { HubDb } from "../db";

// Availability resolution collects the tenant system principal's grants
// (credential-use authorization) before calling resolveModelSources; the probe
// tolerates a tenant with no system principal (returns no grants). The mocked
// resolveModelSources ignores the grant set, so an absent principal is enough.
const db = {
  query: {
    principal: { findFirst: async () => undefined },
  },
} as unknown as HubDb;

describe("listAvailableMyraVariants", () => {
  it("returns only variants whose model resolveModelSources accepts", async () => {
    const available = await listAvailableMyraVariants(db, "tn-1");
    expect(available.length).toBeGreaterThan(0);
    expect(available.every((v) => v.model.includes("deepseek"))).toBe(true);
  });
});

describe("isMyraVariantAvailableForTenant", () => {
  it("is true for a deepseek variant and false for opus", async () => {
    expect(
      await isMyraVariantAvailableForTenant(
        db,
        "tn-1",
        "myra-deepseek-v4-flash",
      ),
    ).toBe(true);
    expect(
      await isMyraVariantAvailableForTenant(db, "tn-1", "myra-opus-4-8"),
    ).toBe(false);
  });

  it("is false for an unknown variant id", async () => {
    expect(
      await isMyraVariantAvailableForTenant(db, "tn-1", "myra-does-not-exist"),
    ).toBe(false);
  });
});

describe("softNullUnavailableVariantSelections", () => {
  it("nulls chat when its model is not launchable and keeps a launchable triage", async () => {
    const result = await softNullUnavailableVariantSelections(db, "tn-1", {
      chat: "myra-opus-4-8",
      triage: "myra-deepseek-v4-flash",
    });
    expect(result.chat).toBeNull();
    expect(result.triage).toBe("myra-deepseek-v4-flash");
  });
});

describe("resolveLaunchableMyraVariant", () => {
  it("keeps a stored selection when its model is launchable", async () => {
    const variant = await resolveLaunchableMyraVariant(
      db,
      "tn-1",
      "chat",
      "myra-deepseek-v4-flash",
    );
    expect(variant.id).toBe("myra-deepseek-v4-flash");
  });

  it("falls through from an unavailable stored pick to a launchable default", async () => {
    const variant = await resolveLaunchableMyraVariant(
      db,
      "tn-1",
      "chat",
      "myra-opus-4-8",
    );
    expect(variant.model.includes("deepseek")).toBe(true);
    expect(variant.kind).toBe("chat");
  });
});
