// `usePresenceRoom` (CL-5958): connects to `@corbits/presence/client` only
// while both tenant and surface are known, tears down and reconnects when
// either changes, and exposes publishCursor/publishTyping as stable
// callbacks. Mocks `@corbits/presence/client` directly rather than a real
// EventSource/fetch — that transport is `@corbits/presence`'s own test
// responsibility, not apps/web's.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

interface FakeHandle {
  roomUrl: string;
  disconnected: boolean;
  listener: ((members: unknown[]) => void) | null;
  cursorCalls: unknown[];
}

const created: FakeHandle[] = [];

mock.module("@corbits/presence/client", () => ({
  connectPresence: (options: { roomUrl: string }) => {
    const handle: FakeHandle = {
      roomUrl: options.roomUrl,
      disconnected: false,
      listener: null,
      cursorCalls: [],
    };
    created.push(handle);
    return {
      subscribe: (listener: (members: unknown[]) => void) => {
        handle.listener = listener;
        listener([]);
        return () => {
          handle.listener = null;
        };
      },
      publishCursor: (cursor: unknown) => handle.cursorCalls.push(cursor),
      publishTyping: () => undefined,
      disconnect: () => {
        handle.disconnected = true;
      },
    };
  },
}));

const { usePresenceRoom } = await import("../src/presence/use-presence-room");

afterEach(() => {
  created.length = 0;
});

function mountHook(
  initialTenantId: string | null,
  initialSurface: string | null,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let latest: ReturnType<typeof usePresenceRoom> | null = null;
  let setArgs: (
    tenantId: string | null,
    surface: string | null,
  ) => void = () => {};

  function Host({
    tenantId,
    surface,
  }: {
    tenantId: string | null;
    surface: string | null;
  }) {
    latest = usePresenceRoom(tenantId, surface);
    return null;
  }

  function Wrapper() {
    const argsRef = useRef({
      tenantId: initialTenantId,
      surface: initialSurface,
    });
    setArgs = (tenantId, surface) => {
      argsRef.current = { tenantId, surface };
      act(() => root.render(createElement(Host, argsRef.current)));
    };
    return createElement(Host, argsRef.current);
  }

  act(() => {
    root.render(createElement(Wrapper));
  });

  return {
    setArgs,
    result: () => latest,
    unmount: () => act(() => root.unmount()),
  };
}

describe("usePresenceRoom", () => {
  test("does not connect when tenantId or surface is null", () => {
    const harness = mountHook(null, "workbench:chn_1");
    expect(created).toHaveLength(0);
    harness.unmount();
  });

  test("connects once both tenantId and surface are present", () => {
    const harness = mountHook("tnt_1", "workbench:chn_1");
    expect(created).toHaveLength(1);
    expect(created[0]?.roomUrl).toBe(
      "/api/tenants/tnt_1/presence/rooms/workbench:chn_1",
    );
    harness.unmount();
  });

  test("disconnects the old room and connects a new one when the surface changes", () => {
    const harness = mountHook("tnt_1", "workbench:chn_1");
    harness.setArgs("tnt_1", "workbench:chn_2");

    expect(created).toHaveLength(2);
    expect(created[0]?.disconnected).toBe(true);
    expect(created[1]?.roomUrl).toBe(
      "/api/tenants/tnt_1/presence/rooms/workbench:chn_2",
    );
    harness.unmount();
  });

  test("publishCursor forwards to the connected handle", () => {
    const harness = mountHook("tnt_1", "workbench:chn_1");
    harness.result()?.publishCursor(0.5, 0.5, 3);

    expect(created[0]?.cursorCalls).toEqual([
      { x: 0.5, y: 0.5, surfaceVersion: 3 },
    ]);
    harness.unmount();
  });

  test("disconnects on unmount", () => {
    const harness = mountHook("tnt_1", "workbench:chn_1");
    harness.unmount();
    expect(created[0]?.disconnected).toBe(true);
  });
});
