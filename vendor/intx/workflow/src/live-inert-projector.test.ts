import { describe, expect, test } from "bun:test";

import { defineWorkflow } from "./definition/workflow";
import { action, onTrigger } from "./definition/primitives";
import { projectLiveToInert } from "./live-inert-projector";
import type { InertOnTrigger } from "./live-inert-projector";

function sectionWorkflow(onBodyFailure?: "end" | "continue") {
  const body = defineWorkflow({
    id: "body",
    triggers: [{ type: "manual" }],
    steps: { reply: action({ handler: "reply" }) },
  });
  return defineWorkflow({
    id: "section-host",
    steps: {
      turn: onTrigger({
        on: { type: "mail", to: "section@example.test" },
        body,
        ...(onBodyFailure !== undefined ? { onBodyFailure } : {}),
      }),
    },
  });
}

function projectedSection(onBodyFailure?: "end" | "continue"): InertOnTrigger {
  const projected = projectLiveToInert(sectionWorkflow(onBodyFailure));
  const step = projected.steps["turn"];
  if (step === undefined || step.kind !== "onTrigger") {
    throw new Error("expected a projected onTrigger section");
  }
  return step;
}

describe("live->inert projection of onTrigger.onBodyFailure", () => {
  test("carries an explicit \"continue\" policy through the projection", () => {
    expect(projectedSection("continue").onBodyFailure).toBe("continue");
  });

  test("carries an explicit \"end\" policy through the projection", () => {
    expect(projectedSection("end").onBodyFailure).toBe("end");
  });

  test("omits the field entirely when the author set no policy", () => {
    const section = projectedSection();
    expect(section.onBodyFailure).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(section, "onBodyFailure")).toBe(
      false,
    );
  });
});
