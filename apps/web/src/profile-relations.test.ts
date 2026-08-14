import { describe, expect, test } from "bun:test";
import type { ProfileSubject } from "@corbits/chat-ui";

import { dmCreateInputFor } from "./profile-relations";

function subject(overrides: Partial<ProfileSubject>): ProfileSubject {
  return {
    kind: "member",
    address: "usr_alice@bench.dev",
    handle: "alice",
    displayName: "Alice",
    initials: "AL",
    ...overrides,
  };
}

describe("dmCreateInputFor", () => {
  test("a person subject creates a chat by principalId, derived from the address local part", () => {
    const input = dmCreateInputFor(subject({}), null);
    expect(input).toEqual({
      kind: "chat",
      principalId: "usr_alice",
      name: "Alice",
    });
  });

  test("an agent subject creates a chat by the definitionId of its running instance", () => {
    const input = dmCreateInputFor(
      subject({
        kind: "agent",
        address: "ins_42@bench.dev",
        handle: "myra",
        displayName: "@myra",
      }),
      "def_myra",
    );
    expect(input).toEqual({
      kind: "chat",
      definitionId: "def_myra",
      name: "@myra",
    });
  });

  test("an agent subject with no matching running instance has no create input", () => {
    const input = dmCreateInputFor(
      subject({ kind: "agent", address: "ins_42@bench.dev" }),
      null,
    );
    expect(input).toBeNull();
  });
});
