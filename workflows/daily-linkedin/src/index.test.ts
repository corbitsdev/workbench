/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { StepInvoker } from "@intx/workflow/runtime";
import { runLocal } from "@intx/workflow/runlocal";
import {
  ARTIFACT_LIST_CAPABILITY,
  ARTIFACT_READ_CAPABILITY,
  INBOX_DELIVER_BATCH_CAPABILITY,
  INTAKE_FIELDS,
  kind,
  label,
  LINKEDIN_DAILY_DRAFT_KIND,
  STORY_BUCKET_ARTIFACT_KIND,
  workflow,
} from "./index";

function agentStepAt(id: string) {
  const primitive = workflow.steps[id];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `expected agent step for "${id}", got ${primitive?.kind ?? "undefined"}`,
    );
  }
  return primitive;
}

describe("daily-linkedin workflow pack", () => {
  test("exports stable kind and label", () => {
    expect(kind).toBe("daily-linkedin");
    expect(label).toBe("Daily LinkedIn");
    expect(workflow.id).toBe(kind);
  });

  test("intake is the only human gate — unattended after the schedule fills it", () => {
    const gates = Object.entries(workflow.steps)
      .filter(([, primitive]) => primitive.kind === "awaitSignal")
      .map(([id]) => id);
    expect(gates).toEqual(["intake"]);
    expect(Object.keys(workflow.steps)).toEqual(["intake", "generate"]);
  });

  // An empty selection means nobody, not everybody (CL-4429), so the field is
  // required — a schedule that picks no one must not be creatable.
  test("INTAKE_FIELDS: required recipient multi-select over the existing member list", () => {
    expect(INTAKE_FIELDS).toHaveLength(1);
    const recipients = INTAKE_FIELDS[0];
    expect(recipients?.name).toBe("recipients");
    expect(recipients?.required).toBe(true);
    expect(recipients?.inputHint).toBe("select-multi");
    // `select-multi` always sources people from GET /members; declaring an
    // optionsSource here would be dead metadata the renderer ignores.
    expect(recipients).not.toHaveProperty("optionsSource");
  });

  // The fan-out contract: the agent may read the roster and evidence and hand
  // ONE batch to the hub, but it may not write artifacts or mail per person —
  // that path is turn-capped and re-spams on every re-run.
  test("generate declares exactly the three canonical capabilities and no write/mail fan-out", () => {
    const generate = agentStepAt("generate");
    expect(generate.agent.capabilities).toEqual([
      ARTIFACT_LIST_CAPABILITY,
      ARTIFACT_READ_CAPABILITY,
      INBOX_DELIVER_BATCH_CAPABILITY,
    ]);
    expect(ARTIFACT_LIST_CAPABILITY).toBe(
      "@workbench/tools-artifact/artifact:artifact_list",
    );
    expect(ARTIFACT_READ_CAPABILITY).toBe(
      "@workbench/tools-artifact/artifact:artifact_read",
    );
    // Hub-backed tools carry no factory id — a prefixed name would not resolve.
    expect(INBOX_DELIVER_BATCH_CAPABILITY).toBe("inbox_deliver_batch");
    // Recipients come from the schedule, so there is no roster-lookup tool.
    const caps0 = generate.agent.capabilities ?? [];
    expect(caps0.some((c) => c.includes("tenant_list_human_principals"))).toBe(
      false,
    );

    const caps = generate.agent.capabilities ?? [];
    expect(caps.some((c) => c.includes("write_artifact"))).toBe(false);
    expect(caps.some((c) => c.endsWith("mail_send"))).toBe(false);
    expect(generate.agent.toolFactories).toEqual([]);
    expect(generate.agent.tags?.["workbench.title"]).toBe(
      "Draft and deliver LinkedIn posts",
    );
  });

  // Regression guard for the failure this workflow's shape invites: the agent
  // passes `userAddress` straight into `inbox_deliver_batch`, and that field is
  // stamped on `trigger.payload` by the hub enricher, NOT collected by the
  // intake gate. A selector reading only `steps.intake.output` would drop it on
  // every fire, and no static check can catch that for an agent step.
  test("generate reads the enriched trigger payload as well as the intake gate", () => {
    const generate = agentStepAt("generate");
    expect(generate.input).toEqual({
      merge: [{ from: "trigger.payload" }, { from: "steps.intake.output" }],
    });
    expect(generate.after).toEqual(["intake"]);
  });

  test("the drafting prompt instructs a single batch deliver, never per-person writes", () => {
    const prompt = agentStepAt("generate").agent.systemPrompt;
    expect(prompt).toContain("Call inbox_deliver_batch at most once per run.");
    // The departed-member skip must reach the human, not be summarized away.
    expect(prompt).toContain(
      "You MUST report every entry in skipped and errors by name, with its reason.",
    );
    expect(prompt).toContain("Never invent, look up, or hard-code a recipient");
    expect(prompt).toContain("Do not call write_artifact or mail_send.");
    expect(prompt).toContain("Never auto-post to LinkedIn");
    expect(prompt).toContain(STORY_BUCKET_ARTIFACT_KIND);
    expect(prompt).toContain(LINKEDIN_DAILY_DRAFT_KIND);
  });

  test("artifact kinds match the story-bucket producer / draft consumer contract", () => {
    expect(STORY_BUCKET_ARTIFACT_KIND).toBe("story-bucket");
    expect(LINKEDIN_DAILY_DRAFT_KIND).toBe("linkedin-daily-draft");
  });

  test("a fire carrying enricher identity plus a roster pick reaches the agent whole", async () => {
    const seen: unknown[] = [];
    const invoker: StepInvoker = async ({ input }) => {
      seen.push(input);
      return { output: { reply: "Delivered 2 drafts." } };
    };

    const run = runLocal(workflow, {
      invokeStep: invoker,
      triggerPayload: {
        userAddress: "usr_owner@workbench.example",
        userRefId: "owner",
        userDisplayName: "Owner",
      },
    });
    await run.signal("intake", {
      recipients: [
        { refId: "alex", displayName: "Alex" },
        { refId: "pontus", displayName: "Pontus" },
      ],
    });
    const result = await run.complete;
    expect(result.terminalStatus).toBe("completed");

    expect(seen).toEqual([
      {
        userAddress: "usr_owner@workbench.example",
        userRefId: "owner",
        userDisplayName: "Owner",
        recipients: [
          { refId: "alex", displayName: "Alex" },
          { refId: "pontus", displayName: "Pontus" },
        ],
      },
    ]);
  });
});
