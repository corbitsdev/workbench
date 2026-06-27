import { describe, expect, it } from "bun:test";
import {
  buildOperatorProfile,
  composePersonalAgentPromptForInstance,
  personalAgentPromptForLaunch,
  promptFormatForProvider,
} from "./operator-profile";

/**
 * Minimal chainable fake of the drizzle select builder: each `.select()` call
 * dequeues the next canned row set, in the query order used by
 * composePersonalAgentPromptForInstance (mapping, then principal, then user).
 */
function fakeDb(resultSets: Record<string, unknown>[][]) {
  let i = 0;
  return {
    select: () => {
      const rows = resultSets[i++] ?? [];
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(rows),
          }),
        }),
      };
    },
  } as never;
}

const OPTS = {
  tenantId: "tnt_1",
  instanceId: "ins_1",
  provider: "openai-compatible",
};
const PERSONAL_MAPPING = {
  templateKey: "myra",
  memberPrincipalId: "prn_member",
};
const USER_PRINCIPAL = { kind: "user", refId: "usr_1" };
const USER_ROW = { name: "Sawyer Cutler", email: "sawyer@abklabs.com" };

describe("promptFormatForProvider", () => {
  it("uses xml only for the anthropic provider", () => {
    expect(promptFormatForProvider("anthropic")).toEqual({ xml: true });
  });

  it("uses markdown for openai-compatible providers (e.g. DeepSeek)", () => {
    expect(promptFormatForProvider("openai-compatible")).toEqual({
      xml: false,
    });
    expect(promptFormatForProvider("openai")).toEqual({ xml: false });
  });
});

describe("buildOperatorProfile", () => {
  it("names the operator and points at the standing brief in memory (no file)", () => {
    const profile = buildOperatorProfile({
      name: "Sawyer Cutler",
      email: "sawyer@abklabs.com",
    });
    expect(profile).toContain("Sawyer Cutler");
    expect(profile).toContain("sawyer@abklabs.com");
    expect(profile).toContain("standing brief");
    expect(profile).not.toContain("MEMORY.md");
  });
});

describe("personalAgentPromptForLaunch", () => {
  it("renders markdown for a non-anthropic provider and includes the operator section", () => {
    const prompt = personalAgentPromptForLaunch({
      provider: "openai-compatible",
      operatorProfile: buildOperatorProfile({
        name: "Sawyer",
        email: "s@x.com",
      }),
    });
    expect(prompt).toContain("## Role");
    expect(prompt).toContain("## Operator");
    expect(prompt).toContain("Sawyer");
    expect(prompt).not.toContain("<role>");
  });

  it("renders xml for the anthropic provider", () => {
    const prompt = personalAgentPromptForLaunch({ provider: "anthropic" });
    expect(prompt).toContain("<role>");
    expect(prompt).not.toContain("## Role");
  });

  it("omits the operator section when no profile is supplied", () => {
    const prompt = personalAgentPromptForLaunch({
      provider: "openai-compatible",
    });
    expect(prompt).not.toContain("## Operator");
  });
});

describe("composePersonalAgentPromptForInstance", () => {
  it("composes a personalized markdown prompt for a personal instance", async () => {
    const db = fakeDb([[PERSONAL_MAPPING], [USER_PRINCIPAL], [USER_ROW]]);
    const prompt = await composePersonalAgentPromptForInstance(db, OPTS);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain("## Operator");
    expect(prompt).toContain("Sawyer Cutler");
    expect(prompt).not.toContain("<role>");
  });

  it("returns null for a non-personal instance (keeps the seeded prompt)", async () => {
    const db = fakeDb([
      [{ templateKey: "oat", memberPrincipalId: "prn_member" }],
    ]);
    expect(await composePersonalAgentPromptForInstance(db, OPTS)).toBeNull();
  });

  it("returns null when the instance has no member mapping", async () => {
    const db = fakeDb([[]]);
    expect(await composePersonalAgentPromptForInstance(db, OPTS)).toBeNull();
  });

  it("still composes (without an operator section) when the user cannot be resolved", async () => {
    const db = fakeDb([[PERSONAL_MAPPING], []]);
    const prompt = await composePersonalAgentPromptForInstance(db, OPTS);
    expect(prompt).not.toBeNull();
    expect(prompt).not.toContain("## Operator");
  });
});
