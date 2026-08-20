// CL-6369: the `next` param on /login is attacker-controllable (a crafted
// `/login?next=...` link) — every case here is either a legitimate in-app
// path or an open-redirect shape that must fall back to `/`.

import { describe, expect, test } from "bun:test";

import { buildLoginRedirect, validatedNextPath } from "./login-next";

describe("buildLoginRedirect", () => {
  test("encodes the path onto /login's next param", () => {
    expect(buildLoginRedirect("/files")).toBe("/login?next=%2Ffiles");
  });

  test("encodes a nested deep link", () => {
    expect(buildLoginRedirect("/w/ch_1")).toBe("/login?next=%2Fw%2Fch_1");
  });
});

describe("validatedNextPath", () => {
  test("no next param means home", () => {
    expect(validatedNextPath("")).toBe("/");
  });

  test("a bare in-app path round-trips", () => {
    expect(validatedNextPath("?next=%2Ffiles")).toBe("/files");
    expect(validatedNextPath("?next=%2Fw%2Fch_1")).toBe("/w/ch_1");
  });

  test("an absolute URL is rejected", () => {
    expect(validatedNextPath("?next=https%3A%2F%2Fevil.example%2Fphish")).toBe(
      "/",
    );
  });

  test("a protocol-relative path is rejected", () => {
    expect(validatedNextPath("?next=%2F%2Fevil.example")).toBe("/");
  });

  test("a backslash trick is rejected", () => {
    expect(validatedNextPath("?next=%2F%5Cevil.example")).toBe("/");
  });

  test("a bare host with no leading slash is rejected", () => {
    expect(validatedNextPath("?next=evil.example")).toBe("/");
  });

  test("a loop back to /login is rejected", () => {
    expect(validatedNextPath("?next=%2Flogin")).toBe("/");
    expect(validatedNextPath("?next=%2Flogin%3Fnext%3D%2Ffiles")).toBe("/");
  });
});
