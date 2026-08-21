import { describe, expect, test } from "bun:test";

import {
  missingCredentialDetail,
  parseMissingCredentialDetail,
} from "./missing-credential-detail";

describe("missingCredentialDetail / parseMissingCredentialDetail", () => {
  test("round-trips a connector id through the wire shape", () => {
    const detail = missingCredentialDetail("github");
    expect(parseMissingCredentialDetail(detail)).toEqual({
      kind: "missing-credential",
      connectorId: "github",
    });
  });

  test("rejects a tool result's detail that isn't this shape", () => {
    expect(parseMissingCredentialDetail(undefined)).toBeUndefined();
    expect(parseMissingCredentialDetail("timed out")).toBeUndefined();
    expect(parseMissingCredentialDetail({ kind: "something-else" })).toBeUndefined();
    expect(
      parseMissingCredentialDetail({ kind: "missing-credential" }),
    ).toBeUndefined();
  });
});
