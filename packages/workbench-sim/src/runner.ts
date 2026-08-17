// Plays a scenario's steps against a booted SimStack and collects the
// facts `metrics.ts` judges: per-send persist latency (POST -> 201),
// server-assigned thread ids for replies, routine fire acceptance, the
// final converged timeline, and DB row growth across the run.

import { expectStatus } from "../../../scripts/e2e/harness.ts";
import type { CollectedRun, RoutineFireRecord, SentMessage } from "./metrics";
import type { Scenario } from "./scenario";
import { validateScenario } from "./scenario";
import type { SimStack } from "./target";

function stringField(data: unknown, field: string): string | undefined {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

export async function executeScenario(
  stack: SimStack,
  scenario: Scenario,
): Promise<CollectedRun> {
  const problems = validateScenario(scenario);
  if (problems.length > 0) {
    throw new Error(
      `invalid scenario "${scenario.name}":\n${problems.join("\n")}`,
    );
  }

  const startedAt = Date.now();
  const dbRowsBefore = await stack.countAllRows();
  const sent: SentMessage[] = [];
  const routineFires: RoutineFireRecord[] = [];
  const messageIdByRef = new Map<string, string>();

  for (const step of scenario.steps) {
    if (stack.sidecarExited()) {
      throw new Error("sidecar exited mid-scenario");
    }
    switch (step.kind) {
      case "label":
        break;
      case "waitQuiet":
        await Bun.sleep(step.ms);
        break;
      case "humanSay": {
        const actor = stack.actors.get(step.actor);
        if (actor === undefined) {
          throw new Error(`no provisioned actor "${step.actor}"`);
        }
        let text = step.text;
        for (const mentionKey of step.mentions ?? []) {
          const agent = stack.agents.get(mentionKey);
          if (agent === undefined) {
            throw new Error(`no provisioned agent "${mentionKey}"`);
          }
          text = `@${agent.handle} ${text}`;
        }
        const body: Record<string, unknown> = {
          parts: [{ kind: "text", text }],
        };
        if (step.inReplyToRef !== undefined) {
          const rootId = messageIdByRef.get(step.inReplyToRef);
          if (rootId === undefined) {
            throw new Error(
              `ref "${step.inReplyToRef}" never resolved to a message id`,
            );
          }
          body["inReplyToMessageId"] = rootId;
        }
        const before = Date.now();
        const res = await stack.api(
          stack.baseUrl,
          "POST",
          `/api/tenants/${stack.tenantId}/chat/channels/${stack.channelId}/messages`,
          body,
          actor.cookies,
        );
        expectStatus(`post "${text.slice(0, 40)}" as ${step.actor}`, res, 201);
        const latencyMs = Date.now() - before;
        const messageId = stringField(res.data, "id");
        if (messageId === undefined) {
          throw new Error(`post returned no id: ${JSON.stringify(res.data)}`);
        }
        if (step.ref !== undefined) messageIdByRef.set(step.ref, messageId);
        const record: SentMessage = {
          actor: step.actor,
          text,
          messageId,
          latencyMs,
        };
        if (step.ref !== undefined) record.ref = step.ref;
        if (step.inReplyToRef !== undefined) {
          record.inReplyToMessageId =
            messageIdByRef.get(step.inReplyToRef) ?? "";
          const threadId = stringField(res.data, "threadId");
          if (threadId !== undefined) record.threadId = threadId;
        }
        sent.push(record);
        break;
      }
      case "routineFire": {
        const routine = stack.routines.get(step.routine);
        if (routine === undefined) {
          throw new Error(`no provisioned routine "${step.routine}"`);
        }
        const res = await stack.api(
          stack.baseUrl,
          "POST",
          `/api/tenants/${stack.tenantId}/routines/${routine.id}/run`,
          {},
          stack.ownerCookies,
        );
        routineFires.push({
          routine: step.routine,
          runId: stringField(res.data, "runId") ?? "",
          accepted: res.status === 201,
        });
        break;
      }
    }
  }

  // Final converged timeline, read as the owner, following the list
  // route's cursor through every page.
  const timelineMessageIds = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const route =
      `/api/tenants/${stack.tenantId}/chat/channels/${stack.channelId}/messages` +
      (cursor !== undefined ? `?cursor=${encodeURIComponent(cursor)}` : "");
    const listed = await stack.api(
      stack.baseUrl,
      "GET",
      route,
      undefined,
      stack.ownerCookies,
    );
    expectStatus("final timeline read", listed, 200);
    const page =
      typeof listed.data === "object" &&
      listed.data !== null &&
      "items" in listed.data
        ? ((listed.data as { items: { id: string }[] }).items ?? [])
        : [];
    for (const item of page) timelineMessageIds.add(item.id);
    cursor = stringField(listed.data, "nextCursor");
    if (cursor === undefined) break;
  }

  const dbRowsAfter = await stack.countAllRows();
  return {
    scenarioName: scenario.name,
    sent,
    timelineMessageIds,
    routineFires,
    dbRowsBefore,
    dbRowsAfter,
    wallClockMs: Date.now() - startedAt,
  };
}
