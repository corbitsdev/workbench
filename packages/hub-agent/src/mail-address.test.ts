import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import { deriveUserMailAddress, UserMailAddressArgs } from "./mail-address";

describe("deriveUserMailAddress", () => {
  test("derives `${userRefId}@${domain}` for a user principal", () => {
    expect(
      deriveUserMailAddress({
        userRefId: "usr_alice",
        domain: "tenant.example",
      }),
    ).toBe("usr_alice@tenant.example");
  });

  test("never produces an ins_-prefixed (agent) address", () => {
    const address = deriveUserMailAddress({
      userRefId: "usr_bob",
      domain: "corbits.dev",
    });
    expect(address.startsWith("ins_")).toBe(false);
    expect(address).toBe("usr_bob@corbits.dev");
  });

  test("rejects a non-string refId", () => {
    expect(() =>
      deriveUserMailAddress({
        userRefId: 42 as unknown as string,
        domain: "tenant.example",
      }),
    ).toThrow();
  });

  test("rejects empty components", () => {
    expect(() =>
      deriveUserMailAddress({ userRefId: "", domain: "tenant.example" }),
    ).toThrow();
    expect(() =>
      deriveUserMailAddress({ userRefId: "usr_alice", domain: "" }),
    ).toThrow();
  });

  test("schema rejects a missing domain", () => {
    const result = UserMailAddressArgs({ userRefId: "usr_alice" });
    expect(result instanceof type.errors).toBe(true);
  });
});
