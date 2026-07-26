import { describe, expect, test } from "bun:test";
import { stepAgentIdMatchesDeployment } from "./tool-credential-member-principal";

describe("stepAgentIdMatchesDeployment", () => {
  test("matches heartbeat intake step agent rows", () => {
    expect(
      stepAgentIdMatchesDeployment(
        "ins_ses_dep-1-heartbeat-intake-linear",
        "ses_dep-1",
      ),
    ).toBe(true);
  });

  test("rejects another deployment's step agent id", () => {
    expect(
      stepAgentIdMatchesDeployment(
        "ins_ses_dep-a-heartbeat-intake-linear",
        "ses_dep-b",
      ),
    ).toBe(false);
  });
});
