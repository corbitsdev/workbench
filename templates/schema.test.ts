import { expect, test } from "bun:test";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";
import { MCP_PRESETS } from "@workbench/connections/mcp-presets";
import { SCOUT_TOOL_PACKAGE_PINS } from "@corbits/scout-agent/definition";

import {
  CODE_REVIEW_TEMPLATE,
  DUE_DILIGENCE_TEMPLATE,
  GTM_TEMPLATE,
  WORKBENCH_TEMPLATES,
  WORKFLOW_CATALOG,
  templateBlockAssetNames,
  workbenchTemplate,
  parseWorkbenchDefinition,
  serializeWorkbenchDefinition,
  workflowCatalogEntry,
} from "./index";

test("every template's blocks are real catalog workflows", () => {
  const known = new Set(WORKFLOW_CATALOG.map((entry) => entry.assetName));
  for (const template of WORKBENCH_TEMPLATES) {
    for (const assetName of templateBlockAssetNames(template)) {
      expect(known).toContain(assetName);
    }
  }
});

test("every connector a template names is a real connector or MCP preset", () => {
  const known = new Set([
    ...Object.keys(CONNECTOR_REGISTRY),
    ...MCP_PRESETS.map((preset) => preset.slug),
  ]);
  for (const template of WORKBENCH_TEMPLATES) {
    for (const connector of [
      ...template.plugins.required,
      ...template.plugins.optional,
    ]) {
      expect(known).toContain(connector);
    }
  }
});

test("a template never both requires and merely offers the same connector", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    const required = new Set(template.plugins.required);
    for (const optional of template.plugins.optional) {
      expect(required).not.toContain(optional);
    }
  }
});

test("only automatable blocks get put on a schedule", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    for (const routine of template.routines) {
      expect(workflowCatalogEntry(routine.blockAssetName)?.automatable).toBe(
        true,
      );
    }
  }
});

test("the GTM template installs the four ported v1 workflows plus the call write-up backbone", () => {
  expect(workbenchTemplate("gtm")).toBe(GTM_TEMPLATE);
  expect(templateBlockAssetNames(GTM_TEMPLATE)).toEqual([
    "granola-call",
    "process-granola-call",
    "attio-task-agent",
    "exa-topic-watch",
    "pain-point-collateral",
  ]);
});

test("the GTM template blocks the create on the two connectors nothing works without", () => {
  expect(GTM_TEMPLATE.plugins.required).toEqual(["attio", "exa"]);
  expect(GTM_TEMPLATE.plugins.optional).toEqual(["granola"]);
});

test("the GTM template schedules call discovery and the web watch, and nothing else", () => {
  expect(GTM_TEMPLATE.routines.map((routine) => routine.key)).toEqual([
    "call-discovery",
    "topic-watch",
  ]);
  expect(
    GTM_TEMPLATE.routines.map((routine) => routine.blockAssetName),
  ).toEqual(["granola-call", "exa-topic-watch"]);
});

test("the watch's one open input reaches the routine that needs it", () => {
  expect(GTM_TEMPLATE.openInputs).toHaveLength(1);
  const [topic] = GTM_TEMPLATE.openInputs;
  expect(topic?.key).toBe("topic");
  expect(topic?.required).toBe(true);
  expect(topic?.appliesToRoutine).toBe("topic-watch");
});

test("every routine-scoped open input names a field the block's own trigger contract carries", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    for (const input of template.openInputs) {
      if (input.appliesToRoutine === undefined) continue;
      const routine = template.routines.find(
        (candidate) => candidate.key === input.appliesToRoutine,
      );
      const fields =
        workflowCatalogEntry(routine?.blockAssetName ?? "")?.triggerFields ??
        [];
      expect(fields.map((field) => field.key)).toContain(input.key);
    }
  }
});

test("every webhook-trigger-scoped open input names a real webhook trigger", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    for (const input of template.openInputs) {
      if (input.appliesToWebhookTrigger === undefined) continue;
      const trigger = template.webhookTriggers.find(
        (candidate) => candidate.key === input.appliesToWebhookTrigger,
      );
      expect(trigger).toBeDefined();
    }
  }
});

test("every webhook trigger's field names a field the block's own trigger contract carries", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    for (const trigger of template.webhookTriggers) {
      const fields =
        workflowCatalogEntry(trigger.blockAssetName)?.triggerFields ?? [];
      expect(fields.map((field) => field.key)).toContain(
        trigger.triggerFieldKey,
      );
    }
  }
});

test("the code-review template installs the code-review workflow and requires github", () => {
  expect(workbenchTemplate("code-review")).toBe(CODE_REVIEW_TEMPLATE);
  expect(templateBlockAssetNames(CODE_REVIEW_TEMPLATE)).toEqual([
    "code-review",
  ]);
  expect(CODE_REVIEW_TEMPLATE.plugins.required).toEqual(["github"]);
});

test("the code-review template fires from a pull-request webhook, not a clock", () => {
  expect(CODE_REVIEW_TEMPLATE.routines).toEqual([]);
  expect(CODE_REVIEW_TEMPLATE.webhookTriggers).toHaveLength(1);
  const [trigger] = CODE_REVIEW_TEMPLATE.webhookTriggers;
  expect(trigger?.key).toBe("pull-request-opened");
  expect(trigger?.blockAssetName).toBe("code-review");
  expect(trigger?.triggerFieldKey).toBe("pullRequestUrl");
});

test("the code-review definition's agents are the three reviewers and nobody else", () => {
  expect(CODE_REVIEW_TEMPLATE.agents.map((agent) => agent.handle)).toEqual([
    "correctness-reviewer",
    "architecture-reviewer",
    "release-risk-reviewer",
  ]);
});

test("the code-review definition names the GitHub tool package its reviewers need", () => {
  expect(CODE_REVIEW_TEMPLATE.tools).toEqual(["@corbits/github-tools"]);
});

test("the code-review walkthrough is connect GitHub, pick repos, start reviewing — in that order", () => {
  expect(CODE_REVIEW_TEMPLATE.onboardingSteps.map((step) => step.kind)).toEqual(
    ["connect-plugin", "pick-github-repos", "start-webhook-trigger"],
  );
  for (const step of CODE_REVIEW_TEMPLATE.onboardingSteps) {
    expect(step.title.length).toBeGreaterThan(0);
    expect(step.why.length).toBeGreaterThan(0);
  }
});

test("agents are addressable by a distinct handle", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    const handles = template.agents.map((agent) => agent.handle);
    expect(new Set(handles).size).toBe(handles.length);
  }
});

test("a definition never names the same tool package twice", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    expect(new Set(template.tools).size).toBe(template.tools.length);
  }
});

test("the due-diligence definition's agents are Myra and Scout, neither backed by a block", () => {
  expect(workbenchTemplate("due-diligence")).toBe(DUE_DILIGENCE_TEMPLATE);
  expect(DUE_DILIGENCE_TEMPLATE.agents.map((agent) => agent.handle)).toEqual([
    "myra",
    "scout",
  ]);
  expect(templateBlockAssetNames(DUE_DILIGENCE_TEMPLATE)).toEqual([]);
  for (const agent of DUE_DILIGENCE_TEMPLATE.agents) {
    expect(agent.blockAssetName).toBeUndefined();
  }
});

test("the due-diligence definition names Scout's tool packages and needs no walkthrough", () => {
  expect(DUE_DILIGENCE_TEMPLATE.tools).toEqual(
    SCOUT_TOOL_PACKAGE_PINS.map((pin) => pin.name),
  );
  expect(DUE_DILIGENCE_TEMPLATE.onboardingSteps).toEqual([]);
});

test("the due-diligence template blocks the create on nothing — Exa is offered, never required", () => {
  expect(DUE_DILIGENCE_TEMPLATE.plugins.required).toEqual([]);
  expect(DUE_DILIGENCE_TEMPLATE.plugins.optional).toEqual(["exa"]);
});

test("Jimmy is not a workbench template — the picker offers no such kind of workbench", () => {
  expect(workbenchTemplate("default-teammates")).toBeUndefined();
  for (const template of WORKBENCH_TEMPLATES) {
    expect(template.agents.some((agent) => agent.handle === "jimmy")).toBe(
      false,
    );
  }
});

test("every shipped definition survives the seed round trip verbatim", () => {
  for (const template of WORKBENCH_TEMPLATES) {
    const parsed = parseWorkbenchDefinition(
      serializeWorkbenchDefinition(template),
    );
    expect(parsed).toEqual(template);
  }
});

test("a malformed library row fails to parse instead of half-loading", () => {
  expect(() => parseWorkbenchDefinition('{"id":"code-review"}')).toThrow(
    /failed to parse/,
  );
  const firstRoutine = GTM_TEMPLATE.routines[0];
  if (!firstRoutine) throw new Error("GTM_TEMPLATE has no routines");
  const orphanRoutine = {
    ...GTM_TEMPLATE,
    routines: [{ ...firstRoutine, blockAssetName: "not-installed" }],
  };
  expect(() =>
    parseWorkbenchDefinition(serializeWorkbenchDefinition(orphanRoutine)),
  ).toThrow(/does not install/);
});

test("a required plugin with no step to connect it fails loud, naming the plugin", () => {
  const unaskedPlugin = {
    ...DUE_DILIGENCE_TEMPLATE,
    plugins: { required: ["exa"], optional: [] },
  };
  expect(() =>
    parseWorkbenchDefinition(serializeWorkbenchDefinition(unaskedPlugin)),
  ).toThrow(/requires plugin "exa" but its onboarding never asks/);
});

test("a walkthrough step naming a connector outside the definition's plugins fails loud", () => {
  const strayConnector = {
    ...DUE_DILIGENCE_TEMPLATE,
    onboardingSteps: [
      {
        kind: "connect-plugin" as const,
        connectorId: "attio",
        title: "Connect Attio",
        why: "Nothing here reads Attio.",
      },
    ],
  };
  expect(() =>
    parseWorkbenchDefinition(serializeWorkbenchDefinition(strayConnector)),
  ).toThrow(/connects "attio", which is not one of its plugins/);
});

test("a start-webhook-trigger step naming an unknown trigger fails loud", () => {
  const unknownTrigger = {
    ...CODE_REVIEW_TEMPLATE,
    onboardingSteps: [
      ...CODE_REVIEW_TEMPLATE.onboardingSteps.slice(0, 2),
      {
        kind: "start-webhook-trigger" as const,
        webhookTriggerKey: "issue-opened",
        title: "Start reviewing",
        why: "Nothing fires on issues.",
      },
    ],
  };
  expect(() =>
    parseWorkbenchDefinition(serializeWorkbenchDefinition(unknownTrigger)),
  ).toThrow(/"issue-opened", which the definition does not create/);
});

test("picking repos before GitHub is connected fails loud — the walkthrough is ordered", () => {
  const outOfOrder = {
    ...CODE_REVIEW_TEMPLATE,
    onboardingSteps: [
      {
        kind: "pick-github-repos" as const,
        title: "Pick your repos",
        why: "Only the repositories you choose get reviewed.",
      },
      ...CODE_REVIEW_TEMPLATE.onboardingSteps.filter(
        (step) => step.kind !== "pick-github-repos",
      ),
    ],
  };
  expect(() =>
    parseWorkbenchDefinition(serializeWorkbenchDefinition(outOfOrder)),
  ).toThrow(/asks for repos before its onboarding connects "github"/);
});
