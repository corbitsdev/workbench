import { describe, expect, test } from "bun:test";

import type { Channel } from "@corbits/chat-ui";

import {
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
