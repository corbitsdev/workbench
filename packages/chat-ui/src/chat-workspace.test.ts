import { describe, expect, test } from "bun:test";

import {
  bringInLoadErrorMessage,
  buildTeamAvatarStack,
} from "./chat-workspace";
import type { ParticipantRecord } from "./api";
import { CHAT_STRINGS } from "./strings";

describe("buildTeamAvatarStack (CL-6594)", () => {
  test("gives every agent participant its own initial and its own generated color, never a shared fallback", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
      { address: "run_scout@dana.localhost", handle: "scout" },
    ];

    const stack = buildTeamAvatarStack(participants, []);

    expect(stack).toHaveLength(2);
    expect(stack.map((entry) => entry.initials)).toEqual(["M", "S"]);
    expect(stack.map((entry) => entry.label)).toEqual(["myra", "scout"]);
    expect(stack.every((entry) => entry.tone === "agent")).toBe(true);

    const [myra, scout] = stack;
    expect(myra?.color).toBeDefined();
    expect(scout?.color).toBeDefined();
    // Distinct addresses must never collapse onto the same fallback
    // fill — this is exactly what a shared CSS accent color did before
    // CL-6594: two agents in one room rendered as indistinguishable
    // avatars.
    expect(myra?.color).not.toBe(scout?.color);
  });

  test("keeps every agent visible alongside live humans, agents first", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
      { address: "run_scout@dana.localhost", handle: "scout" },
    ];

    const stack = buildTeamAvatarStack(participants, [
      {
        principalId: "prn_dana",
        displayName: "Dana",
        color: "hsl(10 70% 60%)",
        textColor: "#000000",
      },
    ]);

    expect(stack.map((entry) => entry.label)).toEqual([
      "myra",
      "scout",
      "Dana",
    ]);
  });

  test("includes the signed-in human from the roster even with empty presence (CL-6779)", () => {
    // Onboarding/template rooms list the human as a participant before any
    // presence snapshot arrives — the stack must not be agent-only.
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
      { address: "prn_dana", handle: "Dana" },
    ];

    const stack = buildTeamAvatarStack(participants, []);

    expect(stack.map((entry) => entry.label)).toEqual(["myra", "Dana"]);
    expect(stack.map((entry) => entry.tone)).toEqual(["agent", "neutral"]);
    const human = stack[1];
    expect(human?.key).toBe("prn_dana");
    expect(human?.initials).toBe("D");
    expect(human?.color).toBeDefined();
  });

  test("dedupes a roster human who is also live in presence", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
      { address: "prn_dana", handle: "Dana" },
    ];

    const stack = buildTeamAvatarStack(participants, [
      {
        principalId: "prn_dana",
        displayName: "Dana Live",
        color: "hsl(10 70% 60%)",
        textColor: "#000000",
      },
    ]);

    expect(stack.map((entry) => entry.label)).toEqual(["myra", "Dana Live"]);
    expect(stack[1]?.color).toBe("hsl(10 70% 60%)");
  });
});

describe("bringInLoadErrorMessage (CL-6839)", () => {
  test("no failures yields null — honest empty stays empty", () => {
    expect(bringInLoadErrorMessage([], null)).toBeNull();
  });

  test("members-only failure uses the people copy", () => {
    expect(bringInLoadErrorMessage(["members"], new Error("x"))).toBe(
      CHAT_STRINGS.mentionMembersLoadError,
    );
  });

  test("invitable-agents-only failure uses the agents copy", () => {
    expect(bringInLoadErrorMessage(["invitableAgents"], new Error("x"))).toBe(
      CHAT_STRINGS.mentionInvitableLoadError,
    );
  });

  test("both failures use the combined copy", () => {
    expect(
      bringInLoadErrorMessage(["members", "invitableAgents"], new Error("x")),
    ).toBe(CHAT_STRINGS.mentionBringInLoadError);
  });
});
