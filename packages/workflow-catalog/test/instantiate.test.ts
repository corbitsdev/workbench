import { expect, test } from "bun:test";
import { CODE_REVIEW_REVIEWERS } from "@corbits/code-review/reviewers";

import {
  CODE_REVIEW_TEMPLATE,
  DUE_DILIGENCE_TEMPLATE,
  GTM_TEMPLATE,
  type WorkbenchOnboardingStep,
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
  readonly invited: string[];
  readonly recordedConnections: (readonly string[])[];
  readonly deployedBlocks: string[];
  readonly calls: string[];
  readonly onboardingSteps: (readonly WorkbenchOnboardingStep[])[];
} {
  const created: string[] = [];
  const invited: string[] = [];
  const recordedConnections: (readonly string[])[] = [];
  const deployedBlocks: string[] = [];
  const calls: string[] = [];
  const onboardingSteps: (readonly WorkbenchOnboardingStep[])[] = [];
  return {
    created,
    invited,
    recordedConnections,
    deployedBlocks,
    calls,
    onboardingSteps,
    async listAgentHandles() {
      return existingHandles.map((handle) => ({ handle, id: `def-${handle}` }));
    },
    async createParticipantAgent(request) {
      created.push(request.handle);
      return { id: `def-${request.handle}` };
    },
    async deployBlockWorkflow(block) {
      deployedBlocks.push(block.assetName);
      return { created: !alreadyDeployedBlocks.includes(block.assetName) };
    },
    async inviteParticipantAgent(id) {
      invited.push(id);
      calls.push(`invite:${id}`);
    },
    async recordPendingConnections(pendingConnections) {
      recordedConnections.push(pendingConnections);
      calls.push("recordPendingConnections");
    },
    async beginOnboarding(steps) {
      onboardingSteps.push(steps);
      calls.push("beginOnboarding");
    },
  };
}

test("instantiating the code-review definition creates the three reviewer definitions, never Myra", () => {
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

// A reviewer whose agent-directory definition already exists (a second
// workbench from the same template) still has to become a participant
// of THIS new room — an existing definition is not an existing
// invitation, so skipping the create must never skip the invite too.
test("instantiating the code-review definition invites every reviewer into the room, created or skipped alike", async () => {
  const ports = fakePorts(["architecture-reviewer"]);
  const result = await instantiateWorkbenchTemplate(
    CODE_REVIEW_TEMPLATE,
    ports,
  );
  expect(result.invitedHandles).toEqual(
    CODE_REVIEW_REVIEWERS.map((reviewer) => reviewer.handle),
  );
  expect(ports.invited).toEqual(
    expect.arrayContaining([
      "def-architecture-reviewer",
      "def-correctness-reviewer",
      "def-release-risk-reviewer",
    ]),
  );
  expect(ports.invited).toHaveLength(3);
});

test("the code-review definition never invites or creates Myra — nobody hosts a template room", async () => {
  const ports = fakePorts(["assistant"]);
  const result = await instantiateWorkbenchTemplate(
    CODE_REVIEW_TEMPLATE,
    ports,
  );
  expect(ports.invited).not.toContain("def-assistant");
  expect(ports.created).not.toContain("myra");
  expect(ports.created).not.toContain("assistant");
  expect(result.invitedHandles).not.toContain("myra");
});

test("the due-diligence definition still invites an existing assistant as Myra", async () => {
  const ports = fakePorts(["assistant"]);
  const result = await instantiateWorkbenchTemplate(
    DUE_DILIGENCE_TEMPLATE,
    ports,
  );
  expect(ports.invited).toContain("def-assistant");
  expect(ports.created).not.toContain("myra");
  expect(result.invitedHandles).toEqual(["myra", "scout"]);
});

test("instantiating the code-review definition begins its walkthrough, in definition order, once everything else is in place", async () => {
  const ports = fakePorts();
  const result = await instantiateWorkbenchTemplate(
    CODE_REVIEW_TEMPLATE,
    ports,
  );
  expect(ports.onboardingSteps).toEqual([CODE_REVIEW_TEMPLATE.onboardingSteps]);
  expect(result.onboardingSteps).toEqual(CODE_REVIEW_TEMPLATE.onboardingSteps);
  expect(ports.calls.at(-1)).toBe("beginOnboarding");
  expect(ports.calls.at(-2)).toBe("recordPendingConnections");
  expect(ports.calls.filter((call) => call.startsWith("invite:"))).toHaveLength(
    3,
  );
});

test("a definition with no onboarding steps never begins a walkthrough", async () => {
  const ports = fakePorts();
  const result = await instantiateWorkbenchTemplate(
    DUE_DILIGENCE_TEMPLATE,
    ports,
  );
  expect(ports.onboardingSteps).toEqual([]);
  expect(ports.calls).not.toContain("beginOnboarding");
  expect(result.onboardingSteps).toEqual([]);
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

test("instantiating a definition with an agent outside the reviewer roster throws rather than silently skipping it", () => {
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
    async inviteParticipantAgent() {
      /* noop */
    },
    async recordPendingConnections() {
      /* noop */
    },
    async beginOnboarding() {
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

// No shipped definition names Jimmy (he is not a "kind of workbench");
// `@corbits/chat-ui`'s "Add Jimmy" quick-create row calls
// `jimmyAgentRequest()` directly instead of going through one. This
// proves `instantiateWorkbenchTemplate`'s request map still resolves his
// handle, so a future template naming him works with no new plumbing.
test("a definition naming Jimmy's handle still resolves and creates him", async () => {
  const definitionNamingJimmy = {
    ...DUE_DILIGENCE_TEMPLATE,
    agents: [
      { handle: "jimmy", displayName: "Jimmy", role: "Replies with a GIF." },
    ],
  };
  const ports = fakePorts();
  const result = await instantiateWorkbenchTemplate(
    definitionNamingJimmy,
    ports,
  );
  expect(result.createdHandles).toEqual(["jimmy"]);
  expect(ports.created).toEqual(["jimmy"]);
});
