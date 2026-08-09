import { describe, expect, test } from "bun:test";

import { createPanelRegistry } from "../src/shell/panel-contribution";

describe("createPanelRegistry", () => {
  test("resolves the first matching contribution for a path", () => {
    const registry = createPanelRegistry([
      {
        id: "chat",
        match: (path) => path === "/c" || path.startsWith("/c/"),
        pageBand: () => ({ title: "Chat" }),
      },
      {
        id: "home",
        match: (path) => path === "/",
        pageBand: () => ({ title: "Home" }),
      },
    ]);

    expect(registry.resolve("/c/abc")?.id).toBe("chat");
    expect(registry.resolve("/")?.id).toBe("home");
    expect(registry.resolve("/unknown")).toBeNull();
  });

  test("register replaces a contribution with the same id", () => {
    const registry = createPanelRegistry();
    registry.register({
      id: "agents",
      match: (path) => path === "/agents",
      pageBand: () => ({ title: "Agents" }),
    });
    registry.register({
      id: "agents",
      match: (path) => path === "/agents",
      pageBand: () => ({ title: "Agents v2" }),
    });
    expect(registry.list()).toHaveLength(1);
    expect(
      registry
        .resolve("/agents")
        ?.pageBand({ path: "/agents", onNavigate: () => undefined, onOpenInCanvas: () => undefined }).title,
    ).toBe("Agents v2");
  });

  test("pins are independent of route resolution", () => {
    // Registry never owns pins — callers keep pins across resolve() calls.
    const registry = createPanelRegistry([
      {
        id: "routines",
        match: (path) => path.startsWith("/routines"),
        pageBand: () => ({ title: "Routines" }),
      },
    ]);
    const pins = [
      {
        id: "c1",
        kind: "channel" as const,
        label: "ops",
        href: "/c/c1",
      },
    ];
    expect(registry.resolve("/routines")?.id).toBe("routines");
    expect(registry.resolve("/agents")).toBeNull();
    expect(pins).toHaveLength(1);
  });
});
