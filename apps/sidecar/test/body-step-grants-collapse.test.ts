// CL-6448: an onTrigger body step's tool calls authorize against the
// deployment's grants. The credentials snapshot is keyed by the PARENT
// stepOrder, so the body's own stepId (`reply`) never appears in it;
// for a single-step deployment the sole entry IS the deployment's
// grant set and the lookup collapses to it (mirroring the head/step
// collapse the body's tool materialization already uses). A multi-step
// snapshot stays strict — an unknown stepId is ambiguous and throws.
import { expect, test } from "bun:test";

import { createCredentialsBackedAuthorize } from "@intx/workflow-host";

const HEAD_GRANTS = [{ resource: "tool:@corbits/x/t", effect: "allow" }];

function evaluatorRecorder(seen: { grants?: readonly unknown[] }) {
  return (call: { grants: readonly unknown[] }) => {
    seen.grants = call.grants;
    return Promise.resolve({ effect: "allow" as const });
  };
}

test("a body stepId absent from a single-step snapshot collapses to the sole entry's grants", async () => {
  const seen: { grants?: readonly unknown[] } = {};
  const authorize = createCredentialsBackedAuthorize(
    {
      current: {
        steps: [
          {
            stepId: "turn",
            address: "run_1@local",
            grants: HEAD_GRANTS,
            contentHash: "h",
          },
        ],
      },
    } as never,
    evaluatorRecorder(seen) as never,
  );

  const result = await authorize("tool:@corbits/x/t", "invoke", {
    stepId: "reply",
    runId: "turn__3",
    attempt: 1,
  } as never);

  expect(result.effect).toBe("allow");
  expect(seen.grants).toBe(HEAD_GRANTS);
});

test("an unknown stepId against a multi-step snapshot stays a loud miss", async () => {
  const authorize = createCredentialsBackedAuthorize(
    {
      current: {
        steps: [
          {
            stepId: "a",
            address: "run_1-a@local",
            grants: [],
            contentHash: "h",
          },
          {
            stepId: "b",
            address: "run_1-b@local",
            grants: [],
            contentHash: "h",
          },
        ],
      },
    } as never,
    evaluatorRecorder({}) as never,
  );

  await expect(
    authorize("tool:@corbits/x/t", "invoke", {
      stepId: "reply",
      runId: "r",
      attempt: 1,
    } as never),
  ).rejects.toThrow("credentialsSnapshot has no entry for stepId reply");
});
