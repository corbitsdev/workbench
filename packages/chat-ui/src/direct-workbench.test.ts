import { describe, expect, test } from "bun:test";

import { findDirectWorkbenchWith } from "./direct-workbench";
import type { Workbench } from "./api";

function workbench(
  id: string,
  participantAddresses: readonly string[],
): Workbench {
  return {
    id,
    title: id,
    kind: "chat",
    pinned: false,
    participants: participantAddresses.map((address) => ({
      address,
      handle: address.split("@")[0] ?? address,
    })),
  };
}

describe("findDirectWorkbenchWith", () => {
  test("returns the first workbench the subject address participates in", () => {
    const workbenches = [
      workbench("c1", ["viewer@x.dev", "someone-else@x.dev"]),
      workbench("c2", ["viewer@x.dev", "subject@x.dev"]),
    ];

    expect(findDirectWorkbenchWith(workbenches, "subject@x.dev")?.id).toBe(
      "c2",
    );
  });

  test("returns undefined when no workbench has that participant", () => {
    const workbenches = [workbench("c1", ["viewer@x.dev"])];

    expect(
      findDirectWorkbenchWith(workbenches, "subject@x.dev"),
    ).toBeUndefined();
  });
});
