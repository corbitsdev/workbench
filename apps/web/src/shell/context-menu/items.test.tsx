import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ContextMenuEntry } from "@corbits/context-menu";

const toastMock = mock(() => undefined);
const actualReactUi = await import("@corbits/react-ui");
mock.module("@corbits/react-ui", () => ({
  ...actualReactUi,
  toast: toastMock,
}));

import { shellContextMenuFor } from "./items";
import type { ShellContextMenuActions } from "./items";
import type { ShellContextMenuTarget } from "./targets";

function itemIds(entries: readonly ContextMenuEntry[]): readonly string[] {
  return entries
    .filter(
      (entry): entry is Extract<ContextMenuEntry, { kind: "item" }> =>
        entry.kind === "item",
    )
    .map((entry) => entry.id);
}

function findItem(entries: readonly ContextMenuEntry[], id: string) {
  const entry = entries.find(
    (candidate) => candidate.kind === "item" && candidate.id === id,
  );
  if (entry === undefined || entry.kind !== "item") {
    throw new Error(`no item "${id}" in menu`);
  }
  return entry;
}

function actions(
  overrides: Partial<ShellContextMenuActions> = {},
): ShellContextMenuActions {
  return {
    tenantId: "tenant-1",
    navigate: mock(() => undefined),
    openProfile: mock(() => undefined),
    cycleTheme: mock(() => undefined),
    signOut: mock(() => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock(() => Promise.resolve()) },
  });
  toastMock.mockClear();
});

describe("shellContextMenuFor: channel", () => {
  const target: ShellContextMenuTarget = {
    type: "channel",
    id: "ch-1",
    title: "Launch Planning",
    pinned: false,
  };

  test("offers rename, pin, and copy-link with a tenant selected", () => {
    const menu = shellContextMenuFor(target, actions());
    expect(itemIds(menu.entries)).toEqual(["rename", "pin", "copy-link"]);
    expect(findItem(menu.entries, "pin").label).toBe("Pin conversation");
  });

  test("labels the pin item Unpin for an already-pinned channel", () => {
    const menu = shellContextMenuFor({ ...target, pinned: true }, actions());
    expect(findItem(menu.entries, "pin").label).toBe("Unpin conversation");
  });

  test("drops the pin item without a selected tenant", () => {
    const menu = shellContextMenuFor(target, actions({ tenantId: null }));
    expect(itemIds(menu.entries)).toEqual(["rename", "copy-link"]);
  });

  test("copy-link writes the channel's canonical URL to the clipboard", async () => {
    const menu = shellContextMenuFor(target, actions());
    findItem(menu.entries, "copy-link").onSelect();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/c/ch-1`,
    );
    expect(toastMock).toHaveBeenCalledWith("Launch Planning link copied");
  });

  test("copy-link surfaces a toast instead of throwing when the clipboard write fails", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: mock(() => Promise.reject(new Error("denied"))) },
    });
    const menu = shellContextMenuFor(target, actions());

    expect(() => findItem(menu.entries, "copy-link").onSelect()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(toastMock).toHaveBeenCalledWith("Couldn't copy the link");
  });
});

describe("shellContextMenuFor: profile", () => {
  test("offers exactly one open-profile item", () => {
    const target: ShellContextMenuTarget = {
      type: "profile",
      address: "agent:echo",
      handle: "echo",
    };
    const openProfile = mock(() => undefined);
    const menu = shellContextMenuFor(target, actions({ openProfile }));
    expect(itemIds(menu.entries)).toEqual(["open-profile"]);
    findItem(menu.entries, "open-profile").onSelect();
    expect(openProfile).toHaveBeenCalledTimes(1);
  });
});

describe("shellContextMenuFor: routine", () => {
  const target: ShellContextMenuTarget = {
    type: "routine",
    id: "rt-1",
    name: "Nightly Digest",
  };

  test("offers open, run-now, and copy-link with a tenant selected", () => {
    const menu = shellContextMenuFor(target, actions());
    expect(itemIds(menu.entries)).toEqual(["open", "run-now", "copy-link"]);
  });

  test("drops run-now without a selected tenant", () => {
    const menu = shellContextMenuFor(target, actions({ tenantId: null }));
    expect(itemIds(menu.entries)).toEqual(["open", "copy-link"]);
  });

  test("open navigates to the routine's canonical route", () => {
    const navigate = mock((_to: string) => undefined);
    const menu = shellContextMenuFor(target, actions({ navigate }));
    findItem(menu.entries, "open").onSelect();
    expect(navigate).toHaveBeenCalledWith("/routines/rt-1");
  });
});

describe("shellContextMenuFor: inbox-filter", () => {
  test("offers only copy-link, pointed at the filter's canonical path", async () => {
    const target: ShellContextMenuTarget = {
      type: "inbox-filter",
      filter: "mention",
    };
    const menu = shellContextMenuFor(target, actions());
    expect(itemIds(menu.entries)).toEqual(["copy-link"]);
    findItem(menu.entries, "copy-link").onSelect();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/inbox/mention`,
    );
  });
});

describe("shellContextMenuFor: insights-run", () => {
  test("offers open and copy-link, pointed at the run's canonical route", () => {
    const target: ShellContextMenuTarget = {
      type: "insights-run",
      id: "run-1",
    };
    const navigate = mock((_to: string) => undefined);
    const menu = shellContextMenuFor(target, actions({ navigate }));
    expect(itemIds(menu.entries)).toEqual(["open", "copy-link"]);
    findItem(menu.entries, "open").onSelect();
    expect(navigate).toHaveBeenCalledWith("/insights/runs/run-1");
  });
});

describe("shellContextMenuFor: account", () => {
  test("offers settings and sign-out, never a bare destructive gesture", () => {
    const menu = shellContextMenuFor({ type: "account" }, actions());
    expect(itemIds(menu.entries)).toEqual(["settings", "sign-out"]);
  });

  test("settings navigates to the settings route", () => {
    const navigate = mock((_to: string) => undefined);
    const menu = shellContextMenuFor(
      { type: "account" },
      actions({ navigate }),
    );
    findItem(menu.entries, "settings").onSelect();
    expect(navigate).toHaveBeenCalledWith("/settings");
  });

  test("sign-out only fires from its own explicit menu item", () => {
    const signOut = mock(() => undefined);
    const menu = shellContextMenuFor({ type: "account" }, actions({ signOut }));
    expect(signOut).not.toHaveBeenCalled();
    findItem(menu.entries, "sign-out").onSelect();
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe("shellContextMenuFor: shell", () => {
  test("offers search, channels, and theme", () => {
    const menu = shellContextMenuFor({ type: "shell" }, actions());
    expect(itemIds(menu.entries)).toEqual(["search", "channels", "theme"]);
  });

  test("theme item calls cycleTheme", () => {
    const cycleTheme = mock(() => undefined);
    const menu = shellContextMenuFor(
      { type: "shell" },
      actions({ cycleTheme }),
    );
    findItem(menu.entries, "theme").onSelect();
    expect(cycleTheme).toHaveBeenCalledTimes(1);
  });
});
