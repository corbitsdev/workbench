import { describe, expect, test } from "bun:test";

import { sharedWorkbenchesWith } from "./shared-workbenches";
import type { Workbench } from "./api";

function workbench(
  id: string,
  title: string,
  participantAddresses: readonly string[],
): Workbench {
  return {
    id,
    title,
    kind: "workbench",
    pinned: false,
    participants: participantAddresses.map((address) => ({
      address,
      handle: address.split("@")[0] ?? address,
    })),
  };
}

describe("sharedWorkbenchesWith", () => {
  test("keeps only workbenches both the viewer and the subject participate in", () => {
    const workbenches = [
      workbench("c1", "General", ["viewer@x.dev", "subject@x.dev"]),
      workbench("c2", "Viewer only", ["viewer@x.dev", "someone-else@x.dev"]),
      workbench("c3", "Subject only", ["subject@x.dev", "someone-else@x.dev"]),
    ];

    const result = sharedWorkbenchesWith(
      workbenches,
      "viewer",
      "subject@x.dev",
    );

    expect(result.map((c) => c.id)).toEqual(["c1"]);
  });

  test("matches the viewer by principal id against the participant address's local part", () => {
    const workbenches = [
      workbench("c1", "DM", ["ins_abc@x.dev", "viewer@x.dev"]),
    ];

    const result = sharedWorkbenchesWith(
      workbenches,
      "viewer",
      "ins_abc@x.dev",
    );

    expect(result).toHaveLength(1);
  });

  test("caps the result at the given limit, mock parity default of 4", () => {
    const workbenches = Array.from({ length: 6 }, (_, i) =>
      workbench(`c${i}`, `Workbench ${i}`, ["viewer@x.dev", "subject@x.dev"]),
    );

    expect(
      sharedWorkbenchesWith(workbenches, "viewer", "subject@x.dev"),
    ).toHaveLength(4);
    expect(
      sharedWorkbenchesWith(workbenches, "viewer", "subject@x.dev", 2),
    ).toHaveLength(2);
  });

  test("reports each shared workbench's title and member count", () => {
    const workbenches = [
      workbench("c1", "Launch planning", [
        "viewer@x.dev",
        "subject@x.dev",
        "third@x.dev",
      ]),
    ];

    const result = sharedWorkbenchesWith(
      workbenches,
      "viewer",
      "subject@x.dev",
    );

    expect(result).toEqual([
      { id: "c1", title: "Launch planning", memberCount: 3 },
    ]);
  });

  test("falls back to a placeholder title for an untitled workbench", () => {
    const workbenches = [
      workbench("c1", "", ["viewer@x.dev", "subject@x.dev"]),
    ];

    const result = sharedWorkbenchesWith(
      workbenches,
      "viewer",
      "subject@x.dev",
    );

    expect(result[0]?.title).toBe("Untitled conversation");
  });
});
