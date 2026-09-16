import { expect, test } from "bun:test";
import { createInMemoryNativePrincipalStore } from "./native-principal";

test("native principal reads stay scoped to the requested tenant", async () => {
  const principals = createInMemoryNativePrincipalStore();
  principals.registerPrincipal("tnt_dm", {
    id: "prn_member",
    kind: "user",
    status: "active",
    refId: "usr_member",
  });

  expect(await principals.getTenantPrincipal("tnt_dm", "prn_member")).toEqual({
    id: "prn_member",
    kind: "user",
    status: "active",
    refId: "usr_member",
  });
  expect(
    await principals.getTenantPrincipal("tnt_other", "prn_member"),
  ).toBeUndefined();
});
