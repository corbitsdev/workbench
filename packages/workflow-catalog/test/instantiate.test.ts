import { expect, test } from "bun:test";
import { CODE_REVIEW_REVIEWERS } from "@corbits/code-review/reviewers";

import { CODE_REVIEW_TEMPLATE, GTM_TEMPLATE } from "../src/index";
import {
  instantiateWorkbenchTemplate,
  type WorkbenchTemplateInstantiationPorts,
} from "../src/instantiate";

function fakePorts(
  existingHandles: readonly string[] = [],
): WorkbenchTemplateInstantiationPorts & {
  readonly created: string[];
  readonly recordedConnections: (readonly string[])[];
} {
  const created: string[] = [];
  const recordedConnections: (readonly string[])[] = [];
  return {
    created,
    recordedConnections,
    async listAgentHandles() {
      return existingHandles;
    },
    async createParticipantAgent(request) {
      created.push(request.handle);
      return { id: `def-${request.handle}` };
    },
    async recordPendingConnections(pendingConnections) {
      recordedConnections.push(pendingConnections);
    },
  };
}

test("instantiating the code-review template creates the three reviewer definitions, never Myra", () => {
  const ports = fakePorts();
  return instantiateWorkbenchTemplate(CODE_REVIEW_TEMPLATE, ports).then(
    (result) => {
      expect(result.createdHandles).toEqual(
        CODE_REVIEW_REVIEWERS.map((reviewer) => reviewer.handle),
      );
      expect(ports.created).toEqual(
        CODE_REVIEW_REVIEWERS.map((reviewer) => reviewer.handle),
      );
      expect(ports.created).not.toContain("myra");
      expect(result.skippedHandles).toEqual([]);
    },
  );
});

test("instantiating the code-review template records its required connections as pending", async () => {
  const ports = fakePorts();
  const result = await instantiateWorkbenchTemplate(
    CODE_REVIEW_TEMPLATE,
    ports,
  );
  expect(result.pendingConnections).toEqual(["github"]);
  expect(ports.recordedConnections).toEqual([["github"]]);
});

test("instantiating the code-review template skips a reviewer that already exists", async () => {
  const ports = fakePorts(["architecture-reviewer"]);
  const result = await instantiateWorkbenchTemplate(
    CODE_REVIEW_TEMPLATE,
    ports,
  );
  expect(result.skippedHandles).toEqual(["architecture-reviewer"]);
  expect(result.createdHandles).toEqual([
    "correctness-reviewer",
    "release-risk-reviewer",
  ]);
  expect(ports.created).not.toContain("architecture-reviewer");
});

test("instantiating the code-review template names an honest TODO for its unbuilt webhook trigger", async () => {
  const ports = fakePorts();
  const result = await instantiateWorkbenchTemplate(
    CODE_REVIEW_TEMPLATE,
    ports,
  );
  expect(result.webhookTriggerTodos).toHaveLength(1);
  expect(result.webhookTriggerTodos[0]).toContain("pull-request-opened");
  expect(result.webhookTriggerTodos[0]).toContain("TODO(CL-6345)");
});

test("instantiating a manifest with a participant outside the reviewer roster throws rather than silently skipping it", () => {
  return expect(
    instantiateWorkbenchTemplate(GTM_TEMPLATE, fakePorts()),
  ).rejects.toThrow(/has no known create-agent request/);
});
