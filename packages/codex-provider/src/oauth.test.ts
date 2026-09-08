import type { FetchLike, TokenResponse } from "@corbits/oauth-core";
import { describe, expect, test } from "bun:test";
import {
  accountIdFromIdToken,
  refreshCodexTokens,
  type CodexTokens,
} from "./index";

function jwtWithPayload(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

function fetchResolving(response: TokenResponse): FetchLike {
  const impl: FetchLike = async (_input, _init) =>
    new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
    });
  impl.preconnect = () => undefined;
  return impl;
}

// A malformed or unexpected id_token must degrade to "no account id"
// instead of throwing, since the caller path (token exchange, refresh) must
// keep functioning for flows that never need the chatgpt-account-id header.
describe("Codex oauth — account id decoding", () => {
  test("returns undefined for malformed or claim-less input", () => {
    expect(accountIdFromIdToken(undefined)).toBeUndefined();
    expect(accountIdFromIdToken("not-a-jwt")).toBeUndefined();
    expect(accountIdFromIdToken("header.%%%not-base64%%%.sig")).toBeUndefined();
    expect(
      accountIdFromIdToken(jwtWithPayload({ sub: "user-1" })),
    ).toBeUndefined();
  });
});

// A refresh response frequently omits id_token entirely; without carrying
// the prior account id forward, chatgpt-account-id silently drops off every
// request after the first refresh.
describe("Codex oauth — refresh account id continuity", () => {
  test("carries the previous account id forward when the refresh response omits id_token", async () => {
    const previous: CodexTokens = {
      access: "old",
      refresh: "refresh-1",
      accountId: "acct-1",
    };
    const refreshed = await refreshCodexTokens(
      "refresh-1",
      0,
      previous,
      fetchResolving({ access_token: "new", refresh_token: "refresh-1" }),
    );
    expect(refreshed.accountId).toBe("acct-1");
  });
});
