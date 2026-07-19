import path from "node:path";
import { describe, expect, test } from "bun:test";

import { sanitizeAddress } from "@workbench/hub-agent";
import {
  deriveDeploymentAddress,
  deriveStepAddress,
} from "@intx/workflow-deploy";

import { stepDeployTreeDir } from "./workflow-substrate-factory";

// The on-disk cutover's load-bearing invariant: the sidecar re-derives the
// step's deploy-tree directory from the deployment mailbox address, and it MUST
// match where the hub staged the tree — the head address for a single-step
// (single-agent / warm) deployment, and the derived per-step address for a
// genuine multi-step deployment. If these drift, the sidecar reads an empty
// tree and the step loses every pinned tool.

const DATA_DIR = "/data";
const DOMAIN = "tenant.example";
const DEPLOYMENT_ID = "dep123";
const MAILBOX = `ins_${DEPLOYMENT_ID}@${DOMAIN}`;

describe("stepDeployTreeDir", () => {
  test("single-step collapses to the head address (where deployInstanceAtHead staged)", () => {
    const dir = stepDeployTreeDir({
      dataDir: DATA_DIR,
      mailboxAddress: MAILBOX,
      stepId: "only-step",
      stepCount: 1,
    });
    const headAddress = deriveDeploymentAddress({
      deploymentId: DEPLOYMENT_ID,
      deploymentDomain: DOMAIN,
    });
    // For a single-step deploy the head IS the mailbox, so the tree lives at
    // the mailbox address itself.
    expect(headAddress).toBe(MAILBOX);
    expect(dir).toBe(path.join(DATA_DIR, sanitizeAddress(MAILBOX)));
  });

  test("multi-step reads each step at its derived address (where stageWorkflowStep staged)", () => {
    const dir = stepDeployTreeDir({
      dataDir: DATA_DIR,
      mailboxAddress: MAILBOX,
      stepId: "analyze",
      stepCount: 3,
    });
    const stepAddress = deriveStepAddress({
      deploymentId: DEPLOYMENT_ID,
      stepId: "analyze",
      deploymentDomain: DOMAIN,
    });
    expect(dir).toBe(path.join(DATA_DIR, sanitizeAddress(stepAddress)));
    // A distinct sibling of the head — not the head tree.
    expect(dir).not.toBe(
      path.join(DATA_DIR, sanitizeAddress(MAILBOX)),
    );
  });

  test("a map-scoped step id collapses to its base step's staged tree", () => {
    const scoped = stepDeployTreeDir({
      dataDir: DATA_DIR,
      mailboxAddress: MAILBOX,
      stepId: "fanout[2]",
      stepCount: 4,
    });
    const base = stepDeployTreeDir({
      dataDir: DATA_DIR,
      mailboxAddress: MAILBOX,
      stepId: "fanout",
      stepCount: 4,
    });
    // Every map iteration reads the one tree staged for the base step.
    expect(scoped).toBe(base);
  });

  test("rejects a mailbox address that is not an ins_<id>@<domain> agent address", () => {
    expect(() =>
      stepDeployTreeDir({
        dataDir: DATA_DIR,
        mailboxAddress: "not-an-address",
        stepId: "s",
        stepCount: 1,
      }),
    ).toThrow(/not a parseable/);
    expect(() =>
      stepDeployTreeDir({
        dataDir: DATA_DIR,
        mailboxAddress: `bare_${DEPLOYMENT_ID}@${DOMAIN}`,
        stepId: "s",
        stepCount: 1,
      }),
    ).toThrow(/not a parseable/);
  });
});
