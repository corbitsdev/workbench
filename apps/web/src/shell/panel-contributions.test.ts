import { describe, expect, test } from "bun:test";

import type { Channel } from "@corbits/chat-ui";

import {
  assignChannelBucket,
  channelDetails,
  panelRenamePayload,
  panelRowMenuLabels,
} from "./panel-contributions";

const baseChannel: Channel = {
  id: "ch_1",
  title: "Launch planning",
  kind: "channel",
  pinned: false,
  participants: [],
};

describe("panel channel row ellipsis menu", () => {
  test("offers Rename + Pin for an unpinned channel", () => {
    expect(panelRowMenuLabels({ pinned: false })).toEqual(["Rename", "Pin"]);
  });

  test("offers Rename + Unpin for a pinned channel", () => {
    expect(panelRowMenuLabels({ pinned: true })).toEqual(["Rename", "Unpin"]);
  });
});

describe("panel rename payload", () => {
  test("returns the trimmed name when it differs", () => {
    expect(panelRenamePayload("  New name  ", "Old")).toBe("New name");
  });

  test("returns undefined when blank", () => {
    expect(panelRenamePayload("   ", "Old")).toBeUndefined();
  });

  test("returns undefined when unchanged", () => {
    expect(panelRenamePayload("Old", "Old")).toBeUndefined();
  });
});

describe("channel details panel contribution", () => {
  test("maps the channel's title, kind, and pinned state", () => {
    expect(channelDetails(baseChannel)).toEqual({
      title: "Launch planning",
      kind: "channel",
      pinned: false,
    });
  });

  test("falls back to the unnamed label for a blank title", () => {
    expect(channelDetails({ ...baseChannel, title: "" }).title).toBe(
      "Untitled channel",
    );
  });

  test("reflects a pinned channel", () => {
    expect(channelDetails({ ...baseChannel, pinned: true }).pinned).toBe(true);
  });
});

describe("assignChannelBucket", () => {
  test("pinned channels go to pinned regardless of kind", () => {
    expect(assignChannelBucket({ ...baseChannel, pinned: true })).toBe(
      "pinned",
    );
    expect(
      assignChannelBucket({
        ...baseChannel,
        kind: "chat",
        pinned: true,
        participants: [{ address: "ins_a@agents.example", handle: "echo" }],
      }),
    ).toBe("pinned");
  });

  test("chats with an agent participant go to agents", () => {
    expect(
      assignChannelBucket({
        ...baseChannel,
        kind: "chat",
        participants: [{ address: "ins_a@agents.example", handle: "echo" }],
      }),
    ).toBe("agents");
  });

  test("chats without agents go to dms", () => {
    expect(
      assignChannelBucket({
        ...baseChannel,
        kind: "chat",
        // Human participants use bare principal ids (no @); agent addresses
        // always carry the "@domain" shape that `isAgentAddress` keys on.
        participants: [{ address: "prn_ada", handle: "ada" }],
      }),
    ).toBe("dms");
  });

  test("ordinary channels go to internal", () => {
    expect(assignChannelBucket(baseChannel)).toBe("internal");
  });
});
