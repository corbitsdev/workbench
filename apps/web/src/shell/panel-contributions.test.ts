import { afterEach, describe, expect, test } from "bun:test";

import type { Channel } from "@corbits/chat-ui";
import { resolvePanelContribution } from "@corbits/shell-layout";

import { channelPath } from "../channel-path";
import { resetPendingLibraryUpload } from "../library-upload";
import {
  assignChannelBucket,
  channelDetails,
  channelRowSignals,
  ensurePanelContributions,
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
      "Untitled conversation",
    );
  });

  test("reflects a pinned channel", () => {
    expect(channelDetails({ ...baseChannel, pinned: true }).pinned).toBe(true);
  });
});

describe("channelRowSignals", () => {
  test("renders nothing when the wire carries no activity fields", () => {
    expect(channelRowSignals(baseChannel, false)).toEqual({});
  });

  test("carries live, a formatted time, and the unread count when present", () => {
    const channel: Channel = {
      ...baseChannel,
      unreadCount: 3,
      lastActivityAt: new Date().toISOString(),
      live: true,
    };
    const signals = channelRowSignals(channel, false);
    expect(signals.unread).toBe(3);
    expect(signals.live).toBe(true);
    expect(signals.time).not.toBe("");
    expect(signals.time).toBeDefined();
  });

  test("forces the unread count to 0 for the open channel, without waiting on a refetch", () => {
    const channel: Channel = { ...baseChannel, unreadCount: 5 };
    expect(channelRowSignals(channel, true).unread).toBe(0);
    expect(channelRowSignals(channel, false).unread).toBe(5);
  });

  test("a channel with unreadCount: 0 (fully read) never shows a badge", () => {
    const channel: Channel = { ...baseChannel, unreadCount: 0 };
    expect(channelRowSignals(channel, false).unread).toBe(0);
  });

  test("carries no sharedLabel for an ordinary, non-projected channel", () => {
    const channel: Channel = { ...baseChannel, unreadCount: 1 };
    expect(channelRowSignals(channel, false).sharedLabel).toBeUndefined();
  });

  test("passes through the server's sharedLabel for a projected channel", () => {
    const channel: Channel = {
      ...baseChannel,
      sharedLabel: "shared via parent · Parent Co",
    };
    expect(channelRowSignals(channel, false).sharedLabel).toBe(
      "shared via parent · Parent Co",
    );
  });
});

describe("library panel contribution", () => {
  test("/library pageBand exposes Upload header action", () => {
    ensurePanelContributions();
    const contribution = resolvePanelContribution("/library");
    expect(contribution?.id).toBe("library");
    if (!contribution) {
      throw new Error("expected library panel contribution");
    }
    const band = contribution.pageBand({
      path: "/library",
      onNavigate: () => undefined,
    });
    expect(
      band.headerActions?.map((action) => ({
        id: action.id,
        label: action.label,
      })),
    ).toEqual([{ id: "upload-artifact", label: "Upload" }]);
  });

  test("/library pageBand exposes a Spaces/Routines quick-action strip", () => {
    ensurePanelContributions();
    const contribution = resolvePanelContribution("/library");
    if (!contribution) {
      throw new Error("expected library panel contribution");
    }
    const navigated: string[] = [];
    const band = contribution.pageBand({
      path: "/library",
      onNavigate: (to) => {
        navigated.push(to);
      },
    });
    expect(
      band.actions?.map((action) => ({ id: action.id, label: action.label })),
    ).toEqual([
      { id: "library-qa-channels", label: "Spaces" },
      { id: "library-qa-routines", label: "Routines" },
    ]);
    band.actions?.[0]?.onSelect();
    band.actions?.[1]?.onSelect();
    expect(navigated).toEqual([channelPath(null), "/routines"]);
  });

  test("Upload off /library navigates without requiring a live listener", () => {
    ensurePanelContributions();
    // Resolve from an on-library path so pageBand exists; action still sees
    // the off-route ctx.path passed into pageBand.
    const contribution = resolvePanelContribution("/library");
    if (!contribution) {
      throw new Error("expected library panel contribution");
    }
    const navigated: string[] = [];
    const band = contribution.pageBand({
      path: "/agents",
      onNavigate: (to) => {
        navigated.push(to);
      },
    });
    const upload = band.headerActions?.find(
      (action) => action.id === "upload-artifact",
    );
    expect(upload).toBeDefined();
    upload?.onSelect();
    expect(navigated).toEqual(["/library"]);
  });

  afterEach(() => {
    resetPendingLibraryUpload();
  });
});

describe("insights panel contribution", () => {
  test("the /insights contribution declares pageSpecific", () => {
    ensurePanelContributions();
    const contribution = resolvePanelContribution("/insights/runs/run_123");
    expect(contribution?.id).toBe("insights");
    expect(contribution?.pageSpecific).toBeDefined();
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

  test("a channel carrying sharedLabel goes to external", () => {
    expect(
      assignChannelBucket({
        ...baseChannel,
        sharedLabel: "shared · Beta Co",
      }),
    ).toBe("external");
  });

  test("pinned wins over shared", () => {
    expect(
      assignChannelBucket({
        ...baseChannel,
        pinned: true,
        sharedLabel: "shared · Beta Co",
      }),
    ).toBe("pinned");
  });
});
