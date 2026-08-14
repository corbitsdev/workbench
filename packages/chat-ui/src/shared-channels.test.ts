import { describe, expect, test } from "bun:test";

import { sharedChannelsWith } from "./shared-channels";
import type { Channel } from "./api";

function channel(
  id: string,
  title: string,
  participantAddresses: readonly string[],
): Channel {
  return {
    id,
    title,
    kind: "channel",
    pinned: false,
    participants: participantAddresses.map((address) => ({
      address,
      handle: address.split("@")[0] ?? address,
    })),
  };
}

describe("sharedChannelsWith", () => {
  test("keeps only channels both the viewer and the subject participate in", () => {
    const channels = [
      channel("c1", "General", ["viewer@x.dev", "subject@x.dev"]),
      channel("c2", "Viewer only", ["viewer@x.dev", "someone-else@x.dev"]),
      channel("c3", "Subject only", ["subject@x.dev", "someone-else@x.dev"]),
    ];

    const result = sharedChannelsWith(channels, "viewer", "subject@x.dev");

    expect(result.map((c) => c.id)).toEqual(["c1"]);
  });

  test("matches the viewer by principal id against the participant address's local part", () => {
    const channels = [channel("c1", "DM", ["ins_abc@x.dev", "viewer@x.dev"])];

    const result = sharedChannelsWith(channels, "viewer", "ins_abc@x.dev");

    expect(result).toHaveLength(1);
  });

  test("caps the result at the given limit, mock parity default of 4", () => {
    const channels = Array.from({ length: 6 }, (_, i) =>
      channel(`c${i}`, `Channel ${i}`, ["viewer@x.dev", "subject@x.dev"]),
    );

    expect(
      sharedChannelsWith(channels, "viewer", "subject@x.dev"),
    ).toHaveLength(4);
    expect(
      sharedChannelsWith(channels, "viewer", "subject@x.dev", 2),
    ).toHaveLength(2);
  });

  test("reports each shared channel's title and member count", () => {
    const channels = [
      channel("c1", "Launch planning", [
        "viewer@x.dev",
        "subject@x.dev",
        "third@x.dev",
      ]),
    ];

    const result = sharedChannelsWith(channels, "viewer", "subject@x.dev");

    expect(result).toEqual([
      { id: "c1", title: "Launch planning", memberCount: 3 },
    ]);
  });

  test("falls back to a placeholder title for an untitled channel", () => {
    const channels = [channel("c1", "", ["viewer@x.dev", "subject@x.dev"])];

    const result = sharedChannelsWith(channels, "viewer", "subject@x.dev");

    expect(result[0]?.title).toBe("Untitled channel");
  });
});
