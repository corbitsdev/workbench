import { describe, expect, test } from "bun:test";

import { isBareScopeQuery, parsePaletteQuery } from "../src/scope";

describe("parsePaletteQuery", () => {
  test("no prefix leaves the whole string unscoped", () => {
    expect(parsePaletteQuery("routines")).toEqual({
      scope: null,
      query: "routines",
    });
  });

  test("empty string is unscoped with an empty query", () => {
    expect(parsePaletteQuery("")).toEqual({ scope: null, query: "" });
  });

  test("# scopes to channels and strips the prefix", () => {
    const result = parsePaletteQuery("#eng");
    expect(result.scope?.kind).toBe("channels");
    expect(result.query).toBe("eng");
  });

  test("@ scopes to people and strips the prefix", () => {
    const result = parsePaletteQuery("@myra");
    expect(result.scope?.kind).toBe("people");
    expect(result.query).toBe("myra");
  });

  test("> scopes to actions and strips the prefix", () => {
    const result = parsePaletteQuery(">theme");
    expect(result.scope?.kind).toBe("actions");
    expect(result.query).toBe("theme");
  });

  test("/ scopes to pages and strips the prefix", () => {
    const result = parsePaletteQuery("/library");
    expect(result.scope?.kind).toBe("pages");
    expect(result.query).toBe("library");
  });

  test("a bare scope prefix yields an empty query", () => {
    expect(parsePaletteQuery("#")).toEqual({
      scope: { prefix: "#", kind: "channels", label: "channels" },
      query: "",
    });
  });

  test("trims whitespace after the prefix", () => {
    expect(parsePaletteQuery("#  eng ")).toEqual({
      scope: { prefix: "#", kind: "channels", label: "channels" },
      query: "eng",
    });
  });

  test("an unrecognized leading character is not a scope", () => {
    expect(parsePaletteQuery("!eng")).toEqual({
      scope: null,
      query: "!eng",
    });
  });
});

describe("isBareScopeQuery", () => {
  test("a bare prefix with nothing after it is bare", () => {
    expect(isBareScopeQuery("#")).toBe(true);
    expect(isBareScopeQuery("@")).toBe(true);
  });

  test("a prefix followed only by whitespace is still bare", () => {
    expect(isBareScopeQuery("#   ")).toBe(true);
  });

  test("a prefix with text after it is not bare", () => {
    expect(isBareScopeQuery("#eng")).toBe(false);
  });

  test("no prefix at all is not a bare scope query", () => {
    expect(isBareScopeQuery("")).toBe(false);
    expect(isBareScopeQuery("eng")).toBe(false);
  });
});
