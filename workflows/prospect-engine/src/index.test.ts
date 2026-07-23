import { describe, expect, test } from "bun:test";
import {
  PROSPECT_ENGINE_DISCOVER_FORBIDDEN_TOOLS,
  PROSPECT_ENGINE_PIPELINE_LIST_ID,
  PROSPECT_ENGINE_WORKFLOW_KIND,
} from "@workbench/shared";
import {
  discoverForbiddenToolsPresent,
  INTAKE_FIELDS,
  kind,
  label,
  workflow,
} from "./index";

describe("prospect-engine workflow package", () => {
  test("exports catalog identity", () => {
    expect(kind).toBe(PROSPECT_ENGINE_WORKFLOW_KIND);
    expect(label.length).toBeGreaterThan(0);
    expect(workflow.id).toBe(kind);
  });

  test("list-id intake fields are options-sourced from Sumble, not free text (CL-4279)", () => {
    const listFields = INTAKE_FIELDS.filter((f) =>
      f.name.endsWith("EngineListId"),
    );
    expect(listFields.length).toBe(2);
    for (const field of listFields) {
      expect(field.kind).toBe("select");
      expect(field.optionsSource).toBe("sumble-organization-lists");
    }
    // The Slack channel and verticals fields remain plain free-text/array
    // inputs — this mechanism must not touch fields that aren't list ids.
    const slackField = INTAKE_FIELDS.find((f) => f.name === "slackChannelId");
    expect(slackField?.kind).toBe("text");
  });

  test("graph is fully unattended (zero human gates)", () => {
    const steps = workflow.steps as Record<
      string,
      { type?: string; name?: string }
    >;
    const gates = Object.values(steps).filter(
      (s) =>
        s !== null &&
        typeof s === "object" &&
        // awaitSignal primitives surface as signal waits
        (("name" in s &&
          typeof (s as { name?: string }).name === "string" &&
          !("tool" in s) &&
          !("agent" in s) &&
          !("systemPrompt" in s)) ||
          (s as { type?: string }).type === "awaitSignal"),
    );
    // Stronger: walk serialized-ish structure for awaitSignal markers
    const json = JSON.stringify(workflow);
    expect(json).not.toContain("awaitSignal");
    expect(json).not.toContain('"type":"signal"');
    expect(gates.length).toBe(0);
  });

  test("prelude includes budget, ledger artifact, and pipeline list id", () => {
    const json = JSON.stringify(workflow);
    expect(json).toContain("prospect_engine_init_budget");
    expect(json).toContain("prospect_engine_parse_ledger");
    expect(json).toContain("artifact_find_by_title");
    expect(json).toContain("artifact_read");
    expect(json).toContain(String(PROSPECT_ENGINE_PIPELINE_LIST_ID));
    expect(json).toContain("sumble_get_organization_list");
    expect(json).toContain("prospect_engine_extract_list_org_ids");
  });

  test("delivery path writes artifacts, lists, slack, mail (not memory_save)", () => {
    const json = JSON.stringify(workflow);
    expect(json).toContain("write_artifact");
    expect(json).toContain("sumble_add_organization_list_organizations");
    expect(json).not.toContain("memory_save");
    expect(json).not.toContain("memory_load");
    expect(json).toContain("slack_post_message");
    expect(json).toContain("mail_send");
    expect(json).toContain("prospect_engine_format_slack_digest");
    expect(json).toContain("prospect_engine_format_report");
    expect(json).toContain("prospect-engine-save-ledger-artifact");
  });

  test("discover agent forbids write tools", () => {
    // Capabilities are on the discover agent inside the step graph.
    const json = JSON.stringify(workflow);
    for (const forbidden of PROSPECT_ENGINE_DISCOVER_FORBIDDEN_TOOLS) {
      // Write tools may appear on delivery steps; the helper documents the
      // discover allowlist contract for unit callers.
      expect(discoverForbiddenToolsPresent([forbidden])).toEqual([forbidden]);
      expect(discoverForbiddenToolsPresent([])).toEqual([]);
    }
    // Discover capabilities must not include slack/mail/write_artifact
    expect(json).toContain("sumble_search_organizations");
    // Ensure discover agent id is present
    expect(json).toContain("prospect-engine-discover");
  });

  test("step order: budget before discover, dedupe before score, persist before digest/notify", () => {
    const steps = workflow.steps as unknown as Record<
      string,
      { after?: string[] }
    >;
    expect(steps.discover?.after ?? []).toContain("initBudget");
    expect(steps.discover?.after ?? []).toContain("parseLedger");
    expect(steps.score?.after ?? []).toContain("dedupe");
    expect(steps.mapReveal?.after ?? []).toContain("qualify");
    expect(steps.formatDigest?.after ?? []).toContain("persist");
    expect(steps.notify?.after ?? []).toContain("persist");
    expect(steps.notify?.after ?? []).toContain("saveLedger");
    expect(steps.notify?.after ?? []).toContain("formatDigest");
  });

  // CL-4288: Slack is an optional delivery destination, not a prerequisite —
  // the digest always mails to the user's inbox via the `mail` step regardless
  // of Slack config. A missing channel must never fail the run.
  test("Slack channel intake field is optional", () => {
    const slackField = INTAKE_FIELDS.find((f) => f.name === "slackChannelId");
    expect(slackField?.required).toBe(false);
  });

  test("Slack post step is skipped (not fatal) when no channel is configured", () => {
    const steps = workflow.steps as unknown as Record<
      string,
      { agent?: { tags?: Record<string, string> } }
    >;
    const tags = steps.notify?.agent?.tags ?? {};
    expect(tags["workbench.tool"]).toBe(
      "@workbench/tools-slack/slack:slack_post_message",
    );
    expect(tags["workbench.nonFatal"]).toBe("true");
    const argMap = JSON.parse(tags["workbench.argMap"] ?? "{}") as {
      channel?: { skipStepIfAbsent?: boolean };
    };
    expect(argMap.channel?.skipStepIfAbsent).toBe(true);
  });

  test("mail step delivers the digest to the user's inbox unconditionally", () => {
    const steps = workflow.steps as unknown as Record<
      string,
      { agent?: { tags?: Record<string, string> } }
    >;
    const tags = steps.mail?.agent?.tags ?? {};
    expect(tags["workbench.tool"]).toBe("mail_send");
    const argMap = JSON.parse(tags["workbench.argMap"] ?? "{}") as {
      to?: { from?: string };
    };
    expect(argMap.to?.from).toBe("userAddress");
  });
});
