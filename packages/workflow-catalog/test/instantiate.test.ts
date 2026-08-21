import { expect, test } from "bun:test";
import { CODE_REVIEW_REVIEWERS } from "@corbits/code-review/reviewers";

import {
  CODE_REVIEW_TEMPLATE,
  DEFAULT_TEAMMATES_TEMPLATE,
  DUE_DILIGENCE_TEMPLATE,
  GTM_TEMPLATE,
} from "../src/index";
import {
  instantiateWorkbenchTemplate,
  type WorkbenchTemplateInstantiationPorts,
} from "../src/instantiate";

function fakePorts(
  existingHandles: readonly string[] = [],
  alreadyDeployedBlocks: readonly string[] = [],
): WorkbenchTemplateInstantiationPorts & {
  readonly created: string[];
  readonly recordedConnections: (readonly string[])[];
  readonly deployedBlocks: string[];
} {
  const created: string[] = [];
  const recordedConnections: (readonly string[])[] = [];
  const deployedBlocks: string[] = [];
  return {
    created,
    recordedConnections,
    deployedBlocks,
    async listAgentHandles() {
      return existingHandles;
    },
    async createParticipantAgent(request) {
      created.push(request.handle);
      return { id: `def-${request.handle}` };
    },
    async deployBlockWorkflow(block) {
      deployedBlocks.push(block.assetName);
      return { created: !alreadyDeployedBlocks.includes(block.assetName) };
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

test("instantiating the code-review template names an honest pending note for its not-yet-scoped webhook trigger", async () => {
  const ports = fakePorts();
  const result = await instantiateWorkbenchTemplate(
    CODE_REVIEW_TEMPLATE,
    ports,
  );
  expect(result.webhookTriggerTodos).toHaveLength(1);
  expect(result.webhookTriggerTodos[0]).toContain("pull-request-opened");
  expect(result.webhookTriggerTodos[0]).toContain("connect-github-setup");
});

test("instantiating the code-review template deploys its referenced code-review block workflow", async () => {
  const ports = fakePorts();
  const result = await instantiateWorkbenchTemplate(
    CODE_REVIEW_TEMPLATE,
    ports,
  );
  expect(ports.deployedBlocks).toEqual(["code-review"]);
  expect(result.deployedBlockAssetNames).toEqual(["code-review"]);
  expect(result.skippedBlockAssetNames).toEqual([]);
});

test("a block workflow the tenant already deployed is reported as skipped, never re-deployed", async () => {
  const ports = fakePorts([], ["code-review"]);
  const result = await instantiateWorkbenchTemplate(
    CODE_REVIEW_TEMPLATE,
    ports,
  );
  expect(result.deployedBlockAssetNames).toEqual([]);
  expect(result.skippedBlockAssetNames).toEqual(["code-review"]);
});

test("instantiating a manifest with a participant outside the reviewer roster throws rather than silently skipping it", () => {
  return expect(
    instantiateWorkbenchTemplate(GTM_TEMPLATE, fakePorts()),
  ).rejects.toThrow(/has no known create-agent request/);
});

test("instantiating the due-diligence template creates Scout, never Myra, with no credential connected", async () => {
  const ports = fakePorts();
  const result = await instantiateWorkbenchTemplate(
    DUE_DILIGENCE_TEMPLATE,
    ports,
  );
  expect(result.createdHandles).toEqual(["scout"]);
  expect(ports.created).toEqual(["scout"]);
  expect(ports.created).not.toContain("myra");
  expect(result.skippedHandles).toEqual([]);
  // No block to deploy and nothing required up front: seeding never
  // fails for want of a connected credential (Exa's MCP preset is
  // keyless, and this template requires nothing at all).
  expect(ports.deployedBlocks).toEqual([]);
  expect(result.pendingConnections).toEqual([]);
});

test("instantiating the due-diligence template twice never creates Scout a second time", async () => {
  const first = fakePorts();
  await instantiateWorkbenchTemplate(DUE_DILIGENCE_TEMPLATE, first);
  const second = fakePorts(["scout"]);
  const result = await instantiateWorkbenchTemplate(
    DUE_DILIGENCE_TEMPLATE,
    second,
  );
  expect(result.createdHandles).toEqual([]);
  expect(result.skippedHandles).toEqual(["scout"]);
  expect(second.created).toEqual([]);
});

test("Scout's create request carries its tool package pins", async () => {
  const requests: { handle: string; toolPackagePins?: readonly string[] }[] =
    [];
  const ports: WorkbenchTemplateInstantiationPorts = {
    async listAgentHandles() {
      return [];
    },
    async createParticipantAgent(request) {
      requests.push(request);
      return { id: `def-${request.handle}` };
    },
    async deployBlockWorkflow() {
      return { created: true };
    },
    async recordPendingConnections() {
      /* noop */
    },
  };
  await instantiateWorkbenchTemplate(DUE_DILIGENCE_TEMPLATE, ports);
  const scout = requests.find((request) => request.handle === "scout");
  expect(scout?.toolPackagePins).toEqual(
    expect.arrayContaining([
      "@corbits/memory-tools",
      "@corbits/web-search-tools",
      "@corbits/scout-agent",
    ]),
  );
});

test("instantiating the default-teammates template creates Jimmy, never Myra", async () => {
  const ports = fakePorts();
  const result = await instantiateWorkbenchTemplate(
    DEFAULT_TEAMMATES_TEMPLATE,
    ports,
  );
  expect(result.createdHandles).toEqual(["jimmy"]);
  expect(ports.created).toEqual(["jimmy"]);
  expect(ports.created).not.toContain("myra");
  expect(result.pendingConnections).toEqual([]);
});

test("instantiating the default-teammates template skips Jimmy once he already exists", async () => {
  const ports = fakePorts(["jimmy"]);
  const result = await instantiateWorkbenchTemplate(
    DEFAULT_TEAMMATES_TEMPLATE,
    ports,
  );
  expect(result.skippedHandles).toEqual(["jimmy"]);
  expect(result.createdHandles).toEqual([]);
  expect(ports.created).toEqual([]);
});
