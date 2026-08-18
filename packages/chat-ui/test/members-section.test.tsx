// DOM-mounted composition tests for the Members settings section's
// removal flow (CL-6122): a two-click `ConfirmButton` per human row that
// DELETEs the participant, shows a busy state while the request is in
// flight, disables the signed-in viewer's own row, and refetches the
// channel's participants on success — the same effect-driven mount
// `agents-section.test.tsx` uses. Stubs `global.fetch` directly,
// never `mock.module`.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ChannelSettingsSurface } from "../src/channel-settings";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type ParticipantFixture = { address: string; handle: string };

function stubFetch(options: {
  participants?: ParticipantFixture[];
  removeStatus?: number;
  onRemove?: (address: string) => void;
  /** Resolves the DELETE response only once this promise resolves —
   * lets a test observe the busy state before the request settles. */
  gateRemoveOn?: Promise<void>;
}) {
  const participants = [...(options.participants ?? [])];
  const removeCalls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    if (/\/sidecar-placement$/.test(path)) {
      return json({ enabled: false, provisionerAvailable: false });
    }
    const removeMatch = /\/chat\/channels\/[^/]+\/participants\/([^/]+)$/.exec(
      path,
    );
    if (removeMatch !== null && init?.method === "DELETE") {
      const address = decodeURIComponent(removeMatch[1] as string);
      if (options.gateRemoveOn !== undefined) {
        await options.gateRemoveOn;
      }
      if (options.removeStatus !== undefined && options.removeStatus >= 400) {
        return json(
          { error: { code: "conflict", message: "cannot remove" } },
          options.removeStatus,
        );
      }
      const index = participants.findIndex((p) => p.address === address);
      if (index === -1) {
        return json({ error: { code: "not_found", message: "no" } }, 404);
      }
      participants.splice(index, 1);
      removeCalls.push(address);
      options.onRemove?.(address);
      return json({ address });
    }
    if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
      return json({
        id: "ch_1",
        title: "General",
        kind: "channel",
        pinned: false,
        participants,
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;

  return { removeCalls };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof ChannelSettingsSurface>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(ChannelSettingsSurface, props));
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

function baseProps(
  overrides: Partial<Parameters<typeof ChannelSettingsSurface>[0]> = {},
) {
  return {
    tenantId: "tnt_1",
    channelId: "ch_1",
    channelTitle: "General",
    onBack: () => undefined,
    onInviteParticipant: () => undefined,
    section: "members" as const,
    ...overrides,
  };
}

function rowFor(el: HTMLElement, handle: string) {
  return Array.from(el.querySelectorAll(".chat-settings-participant-row")).find(
    (row) => row.textContent?.includes(handle),
  ) as HTMLElement | undefined;
}

function buttonInRow(row: HTMLElement | undefined, text: string) {
  return Array.from(row?.querySelectorAll("button") ?? []).find(
    (button) => button.textContent === text,
  ) as HTMLButtonElement | undefined;
}

describe("Members settings section — removal", () => {
  test("a second click removes a member and refetches the participant list", async () => {
    const { removeCalls } = stubFetch({
      participants: [
        { address: "prn_bob", handle: "bob" },
        { address: "prn_alice", handle: "alice" },
      ],
    });
    const el = mount(baseProps());
    await settle();

    const row = rowFor(el, "bob");
    expect(row).toBeDefined();
    const removeButton = buttonInRow(row, "Remove");
    expect(removeButton).toBeDefined();

    act(() => {
      removeButton?.click();
    });
    await settle();

    const confirmButton = buttonInRow(row, "Click again to remove");
    expect(confirmButton).toBeDefined();
    act(() => {
      confirmButton?.click();
    });
    await settle();

    expect(removeCalls).toEqual(["prn_bob"]);
    expect(rowFor(el, "bob")).toBeUndefined();
    expect(rowFor(el, "alice")).toBeDefined();
  });

  test("shows a busy state on the row while the removal request is in flight", async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    stubFetch({
      participants: [{ address: "prn_bob", handle: "bob" }],
      gateRemoveOn: gate,
    });
    const el = mount(baseProps());
    await settle();

    const row = rowFor(el, "bob");
    act(() => {
      buttonInRow(row, "Remove")?.click();
    });
    await settle();
    act(() => {
      buttonInRow(row, "Click again to remove")?.click();
    });
    await settle();

    expect(buttonInRow(row, "Removing…")).toBeDefined();
    expect(buttonInRow(row, "Removing…")?.disabled).toBe(true);

    releaseGate?.();
    await settle();
    expect(rowFor(el, "bob")).toBeUndefined();
  });

  test("disables Remove on the signed-in viewer's own row", async () => {
    stubFetch({
      participants: [
        { address: "prn_alice", handle: "alice" },
        { address: "prn_bob", handle: "bob" },
      ],
    });
    const el = mount(baseProps({ currentUserPrincipalId: "prn_alice" }));
    await settle();

    const ownRow = rowFor(el, "alice");
    const otherRow = rowFor(el, "bob");
    expect(buttonInRow(ownRow, "Remove")?.disabled).toBe(true);
    expect(buttonInRow(otherRow, "Remove")?.disabled).toBeFalsy();
  });

  test("a server refusal (e.g. removal from a chat) shows an inline error and keeps the row", async () => {
    stubFetch({
      participants: [{ address: "prn_bob", handle: "bob" }],
      removeStatus: 409,
    });
    const el = mount(baseProps());
    await settle();

    const row = rowFor(el, "bob");
    act(() => {
      buttonInRow(row, "Remove")?.click();
    });
    await settle();
    act(() => {
      buttonInRow(row, "Click again to remove")?.click();
    });
    await settle();

    expect(rowFor(el, "bob")).toBeDefined();
    expect(el.querySelector(".chat-dialog-error")).not.toBeNull();
  });
});
