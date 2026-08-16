import { expect, test } from "bun:test";

import {
  createMemorySidecarPlacementStore,
  WORKBENCH_OWN_SIDECAR_PLACEMENT,
} from "./store";

test("a tenant with nothing set is disabled by default", async () => {
  const store = createMemorySidecarPlacementStore();
  expect(await store.getEnabled("tnt_1")).toBe(false);
});

test("setEnabled(true) turns the setting on", async () => {
  const store = createMemorySidecarPlacementStore();
  expect(await store.setEnabled("tnt_1", true)).toBe(true);
  expect(await store.getEnabled("tnt_1")).toBe(true);
});

test("setEnabled(false) clears a previously-enabled setting", async () => {
  const store = createMemorySidecarPlacementStore();
  await store.setEnabled("tnt_1", true);
  expect(await store.setEnabled("tnt_1", false)).toBe(false);
  expect(await store.getEnabled("tnt_1")).toBe(false);
});

test("writes exactly the exclusive/same-deployment placement literal", async () => {
  expect(WORKBENCH_OWN_SIDECAR_PLACEMENT).toEqual({
    sharing: "exclusive",
    reuse: "same-deployment",
  });
});

test("tenants are independent", async () => {
  const store = createMemorySidecarPlacementStore();
  await store.setEnabled("tnt_1", true);
  expect(await store.getEnabled("tnt_2")).toBe(false);
});
