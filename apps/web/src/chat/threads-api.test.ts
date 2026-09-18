import { describe, expect, test } from "bun:test";

import { agentDeploySourceAssetName } from "../agent-deploy";
import { MYRA_SOURCE_CONFIG } from "../myra-source";
import { displayAgentName, resolveAvatarName, type RoomParticipant } from "./threads-api";

describe("displayAgentName", () => {
  test("renders Myra's fixed display name for her asset", () => {
    expect(displayAgentName(MYRA_SOURCE_CONFIG.assetName)).toBe(MYRA_SOURCE_CONFIG.displayName);
  });

  test("title-cases a deployed agent's slug with hyphens as spaces", () => {
    expect(displayAgentName(agentDeploySourceAssetName("echo-bot"))).toBe("Echo Bot");
    expect(displayAgentName(agentDeploySourceAssetName("scribe"))).toBe("Scribe");
  });

  test("falls back to the raw name for anything unrecognized", () => {
    expect(displayAgentName("some-other-asset")).toBe("some-other-asset");
  });
});

describe("resolveAvatarName", () => {
  const participants: readonly RoomParticipant[] = [
    { id: "p1", kind: "person", name: "alice", address: "alice@example.com" },
    { id: "a1", kind: "agent", name: "Myra", address: "myra@example.com" },
  ];

  test("uses the person's own real name for their own turn, never 'You'", () => {
    const name = resolveAvatarName(
      { author: "me", authorName: "You", address: "alice@example.com" },
      participants,
    );
    expect(name).toBe("alice");
  });

  test("uses the matching participant's name for another author", () => {
    const name = resolveAvatarName(
      { author: "other", authorName: "myra", address: "myra@example.com" },
      participants,
    );
    expect(name).toBe("Myra");
  });

  test("falls back to authorName when no participant matches", () => {
    const name = resolveAvatarName(
      { author: "other", authorName: "someone", address: "unknown@example.com" },
      participants,
    );
    expect(name).toBe("someone");
  });
});
