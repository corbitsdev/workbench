import { describe, expect, test } from "bun:test";
import {
  WORKBENCH_REFS_MIME_HEADER,
  encodeWorkbenchRefsHeaderValue,
  parseWorkbenchRefsFromHeaderMap,
  parseWorkbenchRefsHeaderValue,
} from "./mailbox-refs-header";

describe("mailbox refs MIME header", () => {
  test("round-trips artifact refs through JSON", () => {
    const refs = [{ kind: "artifact" as const, ref: "art_1", label: "Open brief" }];
    const encoded = encodeWorkbenchRefsHeaderValue(refs);
    expect(JSON.parse(encoded)).toEqual(refs);
    expect(parseWorkbenchRefsHeaderValue(encoded)).toEqual(refs);
  });

  test("reads lowercase header key from a parsed header map", () => {
    const encoded = encodeWorkbenchRefsHeaderValue([
      { kind: "artifact", ref: "a", label: "Open brief" },
    ]);
    const headers = new Map<string, string>();
    headers.set(WORKBENCH_REFS_MIME_HEADER.toLowerCase(), encoded);
    expect(parseWorkbenchRefsFromHeaderMap(headers)).toEqual([
      { kind: "artifact", ref: "a", label: "Open brief" },
    ]);
  });

  test("invalid JSON degrades to undefined", () => {
    expect(parseWorkbenchRefsHeaderValue("not-json")).toBeUndefined();
    expect(parseWorkbenchRefsHeaderValue('[{"kind":"bogus","ref":"x"}]')).toBeUndefined();
  });
});