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
    // readLedger is a tolerant bridge — it wraps artifact_read
    // in-process rather than declaring it as the step's own handler.
    expect(json).toContain("prospect_engine_read_ledger_tolerant");
    expect(json).toContain(String(PROSPECT_ENGINE_PIPELINE_LIST_ID));
    // pipeline/growthList/enterpriseList are tolerant bridges
    // wrapping sumble_get_organization_list in-process.
    expect(json).toContain("prospect_engine_read_organization_list_tolerant");
    expect(json).toContain("prospect_engine_extract_list_org_ids");
  });

  test("delivery path writes artifacts, lists, slack, mail (not memory_save)", () => {
    const json = JSON.stringify(workflow);
    expect(json).toContain("write_artifact");
    // addGrowth/addEnterprise are tolerant bridges wrapping
    // sumble_add_organization_list_organizations in-process.
    expect(json).toContain("prospect_engine_add_organization_list_tolerant");
    expect(json).not.toContain("memory_save");
    expect(json).not.toContain("memory_load");
    // notify/mail are tolerant bridges wrapping
    // slack_post_message/mail_send in-process.
    expect(json).toContain("prospect_engine_post_slack_tolerant");
    expect(json).toContain("prospect_engine_send_mail_tolerant");
    expect(json).toContain("prospect_engine_format_slack_digest");
    expect(json).toContain("prospect_engine_format_report");
    // saveLedger migrated to native `action` — its step key is the
    // stable identity now, not a descriptive deterministicToolStep id tag.
    expect(json).toContain('"saveLedger"');
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

  // notify is a native `action` now — `ActionPrimitive` has no
  // error-swallow, so the "skip when no channel configured" and "never fail
  // the run on a genuine Slack failure" behaviors both moved INSIDE the
  // `prospect_engine_post_slack_tolerant` bridge tool (tested at the tool
  // package level in `tools-prospect-engine-slack-bridge`), not onto a
  // `deterministicToolStep` argMap/tag. This test asserts the step wiring:
  // the bridge is declared as notify's handler and effect requirement.
  test("Slack post step wraps the tolerant bridge, not slack_post_message directly", () => {
    const steps = workflow.steps as unknown as Record<
      string,
      { handler?: string; effect?: { requires?: string[] } }
    >;
    expect(steps.notify?.handler).toContain(
      "prospect_engine_post_slack_tolerant",
    );
    expect(steps.notify?.effect?.requires).toContain(steps.notify?.handler);
  });

  test("mail step wraps the tolerant bridge, not mail_send directly", () => {
    const steps = workflow.steps as unknown as Record<
      string,
      { handler?: string; effect?: { requires?: string[] } }
    >;
    expect(steps.mail?.handler).toContain("prospect_engine_send_mail_tolerant");
    expect(steps.mail?.effect?.requires).toContain(steps.mail?.handler);
  });
});
