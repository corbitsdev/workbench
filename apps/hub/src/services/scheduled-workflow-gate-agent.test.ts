import { describe, expect, it } from "bun:test";
import {
  postIntakeGatesForScheduledDrive,
  SCHEDULED_GATE_TEMPLATE_KEY,
} from "./scheduled-gate-targets";

describe("postIntakeGatesForScheduledDrive", () => {
  it("returns no targets for interactive runs", () => {
    expect(
      postIntakeGatesForScheduledDrive("interactive", [
        { signalName: "confirm" },
      ]),
    ).toEqual([]);
  });

  it("skips intake and returns post-intake gates for scheduler runs", () => {
    expect(
      postIntakeGatesForScheduledDrive("scheduler", [
        { signalName: "intake" },
        { signalName: "confirm" },
        { signalName: "review" },
      ]),
    ).toEqual(["confirm", "review"]);
  });

  it("uses a dedicated Myra template key (not triage)", () => {
    expect(SCHEDULED_GATE_TEMPLATE_KEY).toBe("myra-scheduled-gate");
  });
});