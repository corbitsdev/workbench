import { describe, expect, test } from "bun:test";

import { foldedRunIdsFromChannels } from "./folded-run-ids";
import type { Channel } from "./api";

function channel(partial: Partial<Channel> & Pick<Channel, "id">): Channel {
  return {
    title: "Untitled",
    kind: "channel",
    pinned: false,
    participants: [],
    ...partial,
  };
}

describe("foldedRunIdsFromChannels", () => {
  test("includes each channel's own id (the channel-host anchor's run id)", () => {
    const ids = foldedRunIdsFromChannels([channel({ id: "chan_1" })]);
    expect(ids.has("chan_1")).toBe(true);
  });

  test("includes the instance id recovered from every participant address", () => {
    const ids = foldedRunIdsFromChannels([
      channel({
        id: "chan_1",
        participants: [
          { address: "ins_invited1@ten1.workbench.test", handle: "echo" },
        ],
      }),
    ]);
    expect(ids.has("ins_invited1")).toBe(true);
    expect(ids.has("ins_invited1@ten1.workbench.test")).toBe(false);
  });

  test("unions ids across every channel a tenant holds, of any kind", () => {
    const ids = foldedRunIdsFromChannels([
      channel({ id: "chan_1", kind: "channel" }),
      channel({
        id: "chan_2",
        kind: "chat",
        participants: [
          { address: "ins_invited1@ten1.workbench.test", handle: "echo" },
        ],
      }),
      channel({ id: "chan_3", kind: "future-kind" }),
    ]);
    expect([...ids].sort()).toEqual(
      ["chan_1", "chan_2", "chan_3", "ins_invited1"].sort(),
    );
  });

  test("an empty channel list yields an empty set", () => {
    expect(foldedRunIdsFromChannels([]).size).toBe(0);
  });
});
