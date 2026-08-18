// CL-6151: the Keys & plugins card collapsed its two badges (a connection
// status chip and a separate "Set here"/"Workbench default" provenance
// chip) into the one status a person actually needs — see
// `pluginCardStatus`'s doc comment for why "Needs attention" always wins.

import { describe, expect, test } from "bun:test";

import type { ResolvedPlugin } from "@workbench/connections/plugins";
import { pluginCardStatus } from "./plugins-section";

function plugin(overrides: Record<string, unknown> = {}): ResolvedPlugin {
  return {
    descriptor: { id: "anthropic", displayName: "Anthropic" },
    status: "not_connected",
    provenance: null,
    credentialId: null,
    credentialName: null,
    ...overrides,
  } as unknown as ResolvedPlugin;
}

describe("pluginCardStatus", () => {
  test("connected here reads as its own status, not a second chip", () => {
    expect(
      pluginCardStatus(
        plugin({ status: "connected", provenance: "this-workbench" }),
      ),
    ).toEqual({ label: "Connected here", tone: "success" });
  });

  test("an inherited connection reads as using the shared key", () => {
    expect(
      pluginCardStatus(
        plugin({ status: "connected", provenance: "inherited" }),
      ),
    ).toEqual({ label: "Using shared key", tone: "neutral" });
  });

  test("nothing connected anywhere reads not connected", () => {
    expect(
      pluginCardStatus(plugin({ status: "not_connected", provenance: null })),
    ).toEqual({ label: "Not connected", tone: "neutral" });
  });

  test("needs_attention always wins, regardless of provenance", () => {
    expect(
      pluginCardStatus(
        plugin({ status: "needs_attention", provenance: "this-workbench" }),
      ),
    ).toEqual({ label: "Needs attention", tone: "danger" });
    expect(
      pluginCardStatus(
        plugin({ status: "needs_attention", provenance: "inherited" }),
      ),
    ).toEqual({ label: "Needs attention", tone: "danger" });
  });
});
