import { describe, expect, test } from "bun:test";
import { cookiesFromHeader } from "./cookies";

describe("cookiesFromHeader", () => {
  test("returns an empty array for an absent header", () => {
    expect(cookiesFromHeader(undefined)).toEqual([]);
  });

  test("splits a multi-pair Cookie header on ';' and trims whitespace", () => {
    expect(cookiesFromHeader("a=1;  b=2 ;c=3")).toEqual(["a=1", "b=2", "c=3"]);
  });

  test("drops empty segments from a trailing or doubled separator", () => {
    expect(cookiesFromHeader("a=1;;  ;b=2;")).toEqual(["a=1", "b=2"]);
  });
});
