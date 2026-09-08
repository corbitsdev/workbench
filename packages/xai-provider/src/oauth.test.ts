import { describe, expect, test } from "bun:test";
import { xaiUserIdFromAccessToken } from "./index";

function jwtWithPayload(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

describe("xAI oauth — user id decoding", () => {
  test("returns undefined for a malformed payload instead of throwing", () => {
    // Load-bearing: the proxy header is a label decoded from the access
    // token, not an authorization decision. API-key credentials and truncated
    // JWTs must not throw on the request path — a throw would abort a turn
    // that can still authenticate via Bearer.
    expect(xaiUserIdFromAccessToken("not-a-jwt")).toBeUndefined();
    expect(
      xaiUserIdFromAccessToken("header.%%%not-base64%%%.sig"),
    ).toBeUndefined();
    expect(
      xaiUserIdFromAccessToken(jwtWithPayload({ sub: 123 })),
    ).toBeUndefined();
  });
});
