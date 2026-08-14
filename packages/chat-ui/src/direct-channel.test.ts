import { describe, expect, test } from "bun:test";

import { findDirectChannelWith } from "./direct-channel";
import type { Channel } from "./api";

function channel(id: string, participantAddresses: readonly string[]): Channel {
  return {
    id,
    title: id,
    kind: "chat",
    pinned: false,
    participants: participantAddresses.map((address) => ({
      address,
      handle: address.split("@")[0] ?? address,
    })),
  };
}

describe("findDirectChannelWith", () => {
  test("returns the first channel the subject address participates in", () => {
    const channels = [
      channel("c1", ["viewer@x.dev", "someone-else@x.dev"]),
      channel("c2", ["viewer@x.dev", "subject@x.dev"]),
    ];

    expect(findDirectChannelWith(channels, "subject@x.dev")?.id).toBe("c2");
  });

  test("returns undefined when no channel has that participant", () => {
    const channels = [channel("c1", ["viewer@x.dev"])];

    expect(findDirectChannelWith(channels, "subject@x.dev")).toBeUndefined();
  });
});
