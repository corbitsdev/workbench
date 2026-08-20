import { describe, expect, test } from "bun:test";

import { EMPTY_POLICY } from "./policy";
import { applyPolicyPatch, createMemoryBenchModelPolicyStore } from "./store";

describe("bench model policy store", () => {
  test("a bench that has never set a policy is unconstrained", async () => {
    const store = createMemoryBenchModelPolicyStore();
    expect(await store.getPolicy("bench-1")).toEqual(EMPTY_POLICY);
  });

  test("a patch touches only the fields it names", async () => {
    const store = createMemoryBenchModelPolicyStore();
    await store.patchPolicy("bench-1", { deny: ["provider:pricey"] });
    const policy = await store.patchPolicy("bench-1", { ceilingIsHard: true });
    expect(policy.deny).toEqual(["provider:pricey"]);
    expect(policy.ceilingIsHard).toBe(true);
    expect(policy.allow).toEqual([]);
  });

  test("policies are per bench", async () => {
    const store = createMemoryBenchModelPolicyStore();
    await store.patchPolicy("bench-1", { allow: ["alpha"] });
    expect((await store.getPolicy("bench-2")).allow).toEqual([]);
  });
});

describe("applyPolicyPatch", () => {
  test("null clears a ceiling; absent leaves it alone", () => {
    const withCeiling = applyPolicyPatch(EMPTY_POLICY, {
      maxInputUsdPerMTok: 2,
      maxOutputUsdPerMTok: 8,
    });
    const cleared = applyPolicyPatch(withCeiling, { maxInputUsdPerMTok: null });
    expect(cleared.maxInputUsdPerMTok).toBeNull();
    expect(cleared.maxOutputUsdPerMTok).toBe(8);
  });

  test("a concept ceiling override fills the axes it omits with null", () => {
    const patched = applyPolicyPatch(EMPTY_POLICY, {
      conceptCeilings: { "cheap-loop": { maxInputUsdPerMTok: 1 } },
    });
    expect(patched.conceptCeilings["cheap-loop"]).toEqual({
      maxInputUsdPerMTok: 1,
      maxOutputUsdPerMTok: null,
    });
  });

  test("a provider preference can be cleared back to none", () => {
    const pinned = applyPolicyPatch(EMPTY_POLICY, {
      providerPreference: { mode: "pin", order: ["acme"] },
    });
    expect(
      applyPolicyPatch(pinned, { providerPreference: null }).providerPreference,
    ).toBeNull();
  });
});
