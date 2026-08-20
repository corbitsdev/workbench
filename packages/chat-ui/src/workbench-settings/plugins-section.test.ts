// CL-6215: the Plugins section is a marketplace-style directory — every
// registered tool connector, active (connected here or inherited) first,
// available below — rather than a grid of status cards. These are the pure
// pieces the directory's render depends on: which group a resolved plugin
// falls into, and which of it matches a search query.

import { describe, expect, test } from "bun:test";

import type { ResolvedPlugin } from "@workbench/connections/plugins";
import { splitPluginDirectory } from "./plugins-section";

function plugin(overrides: Record<string, unknown> = {}): ResolvedPlugin {
  return {
    descriptor: {
      id: "anthropic",
      displayName: "Anthropic",
      feedsTools: ["@corbits/some-tools"],
    },
    status: "not_connected",
    provenance: null,
    credentialId: null,
    credentialName: null,
    ...overrides,
  } as unknown as ResolvedPlugin;
}

describe("splitPluginDirectory", () => {
  test("a connected-here plugin is active", () => {
    const { active, available } = splitPluginDirectory([
      plugin({ status: "connected", provenance: "this-workbench" }),
    ]);
    expect(active).toHaveLength(1);
    expect(available).toHaveLength(0);
  });

  test("an inherited plugin is active, not merely available", () => {
    const { active, available } = splitPluginDirectory([
      plugin({ status: "connected", provenance: "inherited" }),
    ]);
    expect(active).toHaveLength(1);
    expect(available).toHaveLength(0);
  });

  test("a needs-attention plugin stays active — it's a broken connection, not a bare listing", () => {
    const { active, available } = splitPluginDirectory([
      plugin({ status: "needs_attention", provenance: "this-workbench" }),
    ]);
    expect(active).toHaveLength(1);
    expect(available).toHaveLength(0);
  });

  test("nothing connected anywhere is available, not active", () => {
    const { active, available } = splitPluginDirectory([
      plugin({ status: "not_connected", provenance: null }),
    ]);
    expect(active).toHaveLength(0);
    expect(available).toHaveLength(1);
  });
});
