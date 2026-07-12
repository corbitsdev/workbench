import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  deriveUserMailAddress,
  splitMailAddress,
  splitMailAddressList,
  UserMailAddressArgs,
} from "./mail-address";

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

describe("splitMailAddress", () => {
  test("splits a plain address into local and domain", () => {
    expect(splitMailAddress("usr_alice@tenant.example")).toEqual({
      local: "usr_alice",
      domain: "tenant.example",
    });
  });

  test("splits on the LAST @ when the local part contains one", () => {
    expect(splitMailAddress("usr_a@b@tenant.example")).toEqual({
      local: "usr_a@b",
      domain: "tenant.example",
    });
  });

  test("returns null for an address with no @", () => {
    expect(splitMailAddress("not-an-address")).toBeNull();
  });

  test("returns null when the local or domain part is empty", () => {
    expect(splitMailAddress("@tenant.example")).toBeNull();
    expect(splitMailAddress("usr_alice@")).toBeNull();
  });
});

describe("splitMailAddressList", () => {
  test("splits a bare comma-separated list", () => {
    expect(
      splitMailAddressList("usr_alice@tenant.example, usr_bob@tenant.example"),
    ).toEqual(["usr_alice@tenant.example", "usr_bob@tenant.example"]);
  });

  test("does not split a comma inside a quoted display name", () => {
    expect(
      splitMailAddressList(
        '"Doe, Jane" <a@b>, usr_bob@tenant.example',
      ),
    ).toEqual(['"Doe, Jane" <a@b>', "usr_bob@tenant.example"]);
  });

  test("returns an empty array for an empty value", () => {
    expect(splitMailAddressList("")).toEqual([]);
  });
});
