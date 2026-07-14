import { describe, expect, test } from "bun:test";
import {
  composeMemberResolvers,
  createEmailMemberResolver,
} from "./slack-member-mapping";
import type { InboxIntakeMember } from "../services/inbox-source-registry";

const TENANT = "ten-1";
const member: InboxIntakeMember = {
  tenantId: TENANT,
  memberPrincipalId: "prn-1",
  inboxAddress: "usr_1@corp.test",
  tenantDomain: "corp.test",
  email: "match@corp.test",
};

describe("createEmailMemberResolver", () => {
  test("resolves a slack user whose email matches a member (case-insensitive)", async () => {
    const resolver = createEmailMemberResolver({
      listMembers: async () => [member],
      lookupEmail: async () => "Match@Corp.Test",
    });
    const resolved = await resolver.resolveMember(
      TENANT,
      "U1",
      new AbortController().signal,
    );
    expect(resolved).toEqual(member);
  });

  test("returns null and never guesses when the email matches no member", async () => {
    const resolver = createEmailMemberResolver({
      listMembers: async () => [member],
      lookupEmail: async () => "stranger@nope.test",
    });
    const resolved = await resolver.resolveMember(
      TENANT,
      "U1",
      new AbortController().signal,
    );
    expect(resolved).toBeNull();
  });

  test("returns null when the slack user has no email on file", async () => {
    const resolver = createEmailMemberResolver({
      listMembers: async () => [member],
      lookupEmail: async () => null,
    });
    const resolved = await resolver.resolveMember(
      TENANT,
      "U1",
      new AbortController().signal,
    );
    expect(resolved).toBeNull();
  });

  test("caches the email lookup so a second call does not re-invoke lookupEmail", async () => {
    let calls = 0;
    const resolver = createEmailMemberResolver({
      listMembers: async () => [member],
      lookupEmail: async () => {
        calls += 1;
        return "match@corp.test";
      },
    });
    const signal = new AbortController().signal;
    await resolver.resolveMember(TENANT, "U1", signal);
    await resolver.resolveMember(TENANT, "U1", signal);
    expect(calls).toBe(1);
  });
});

describe("composeMemberResolvers", () => {
  test("returns the first resolver's match without calling the second", async () => {
    let secondCalled = false;
    const first = createEmailMemberResolver({
      listMembers: async () => [member],
      lookupEmail: async () => "match@corp.test",
    });
    const second = {
      async resolveMember() {
        secondCalled = true;
        return member;
      },
    };
    const composed = composeMemberResolvers(first, second);
    const resolved = await composed.resolveMember(
      TENANT,
      "U1",
      new AbortController().signal,
    );
    expect(resolved).toEqual(member);
    expect(secondCalled).toBe(false);
  });

  test("falls through to the second resolver when the first returns null", async () => {
    const first = {
      async resolveMember() {
        return null;
      },
    };
    const second = createEmailMemberResolver({
      listMembers: async () => [member],
      lookupEmail: async () => "match@corp.test",
    });
    const composed = composeMemberResolvers(first, second);
    const resolved = await composed.resolveMember(
      TENANT,
      "U1",
      new AbortController().signal,
    );
    expect(resolved).toEqual(member);
  });
});
