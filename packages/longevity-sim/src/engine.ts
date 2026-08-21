// Drives a built `PlanStep[]` against a booted `LongevityStack`,
// recording latencies, failures, and self-improvement checks into a
// `CampaignReport`. HTTP + SQL only — no plan construction, no
// metrics math (that's `./plan.ts` and `./metrics.ts`, owned by the
// pure-core agent).

import { api, expectStatus } from "../../../scripts/e2e/harness.ts";
import {
  arrayField,
  stringField,
  type LongevityStack,
  type StackAgent,
} from "./stack";
import {
  collectCheckpoint,
  newCheckpointWindow,
  type CheckpointWindow,
} from "./probes";
import type { CampaignConfig } from "./config";
import type { PlanStep } from "./plan";
import { findKnees, type CheckpointRecord } from "./metrics";
import type { Defect, CampaignReport } from "./report";

export interface CampaignHooks {
  onProgress?: (info: { atMessages: number; kind: string }) => void;
}

const CONSECUTIVE_SEND_FAILURE_ABORT = 50;
const MENTION_TURN_POLL_TIMEOUT_MS = 120_000;
const REAL_TURN_POLL_TIMEOUT_MS = 240_000;
const ROUTINE_SCHEDULER_WAIT_MS = 45_000;
const RESTART_RECOVERY_WINDOW_MS = 30_000;
const RESTART_RECOVERY_DEFECT_THRESHOLD_MS = 15_000;

// Every agent is real inference now (no zero-cost noop stub left), so
// the campaign paces itself rather than firing sends as fast as the
// HTTP layer allows: an overall send-rate cap (every send, mention or
// not) and a pending-turn budget gate applied before any send that
// mentions an agent — these models can think for a while before
// replying, so a burst of mentions with nothing pacing them would pile
// up an unbounded number of concurrent turns against a handful of
// local Ollama hosts.
const MIN_SEND_INTERVAL_MS = 200; // caps the overall send rate at ~5/s
const MAX_PENDING_TURNS = 8;
const PENDING_GATE_MAX_WAIT_MS = 180_000;

interface AgentTurnRow {
  id: string;
  workbenchId: string;
  agentAddress: string;
  status: "running" | "completed" | "failed";
  requestMessageIds: readonly string[];
  replyMessageId: string | null;
  startedAt: string;
  endedAt: string | null;
}

interface MutableCounters {
  collectorFailures: number;
  sendFailures: number;
  turnFailures: number;
  routineFiresTotal: number;
  routineFiresAccepted: number;
}

async function postMessage(
  stack: LongevityStack,
  cookies: string[],
  text: string,
  inReplyToMessageId?: string,
): Promise<{ id: string; latencyMs: number } | { error: string }> {
  const start = performance.now();
  const res = await api(
    stack.baseUrl,
    "POST",
    `/api/tenants/${stack.tenantId}/chat/workbenches/${stack.workbenchId}/messages`,
    inReplyToMessageId === undefined
      ? { parts: [{ kind: "text", text }] }
      : { parts: [{ kind: "text", text }], inReplyToMessageId },
    cookies,
  );
  const latencyMs = performance.now() - start;
  if (res.status !== 201) {
    return {
      error: `expected 201, got ${res.status}: ${JSON.stringify(res.data)}`,
    };
  }
  return { id: stringField(res.data, "id", "post message"), latencyMs };
}

async function listTurns(stack: LongevityStack): Promise<AgentTurnRow[]> {
  const res = await api(
    stack.baseUrl,
    "GET",
    `/api/tenants/${stack.tenantId}/chat/workbenches/${stack.workbenchId}/turns`,
    undefined,
    stack.ownerCookies,
  );
  expectStatus("list turns", res, 200);
  return arrayField(
    res.data,
    "items",
    "list turns",
  ) as unknown as AgentTurnRow[];
}

/** Polls turns until one whose `requestMessageIds` contains `messageId`
 * settles (status !== "running"), bounded by `timeoutMs`. Returns
 * `undefined` on timeout — the caller decides whether that is a
 * recorded turn failure. */
async function waitForTurnSettled(
  stack: LongevityStack,
  messageId: string,
  timeoutMs: number,
): Promise<AgentTurnRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const turns = await listTurns(stack);
    const turn = turns.find((t) => t.requestMessageIds.includes(messageId));
    if (turn !== undefined && turn.status !== "running") return turn;
    if (Date.now() > deadline) return undefined;
    await Bun.sleep(1000);
  }
}

function turnLatencyMs(turn: AgentTurnRow): number {
  if (turn.endedAt === null) return 0;
  return new Date(turn.endedAt).getTime() - new Date(turn.startedAt).getTime();
}

async function fetchMessageText(
  stack: LongevityStack,
  messageId: string,
): Promise<string | undefined> {
  const res = await api(
    stack.baseUrl,
    "GET",
    `/api/tenants/${stack.tenantId}/chat/workbenches/${stack.workbenchId}/messages`,
    undefined,
    stack.ownerCookies,
  );
  expectStatus("read messages for reply text", res, 200);
  const items = arrayField(
    res.data,
    "items",
    "read messages for reply text",
  ) as {
    id: string;
    parts: { kind: string; text?: string }[];
  }[];
  const message = items.find((item) => item.id === messageId);
  if (message === undefined) return undefined;
  const textPart = message.parts.find((p) => p.kind === "text");
  return textPart?.text;
}

export async function executeCampaign(
  stack: LongevityStack,
  steps: readonly PlanStep[],
  config: CampaignConfig,
  hooks?: CampaignHooks,
): Promise<CampaignReport> {
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const agents = new Map<string, StackAgent>(stack.agents);
  const refs = new Map<string, string>();
  const defects: Defect[] = [];
  const selfImprovement: { name: string; pass: boolean; detail: string }[] = [];
  const checkpoints: CheckpointRecord[] = [];
  const notes: string[] = [];

  const counters: MutableCounters = {
    collectorFailures: 0,
    sendFailures: 0,
    turnFailures: 0,
    routineFiresTotal: 0,
    routineFiresAccepted: 0,
  };

  let messagesSent = 0;
  let mentionsSeen = 0;
  let consecutiveSendFailures = 0;
  let window: CheckpointWindow = newCheckpointWindow(0, startedAtMs);
  let providerSwitchIndex = 0;
  let nextSendAllowedAt = Date.now();

  /** Enforces the overall send-rate cap ahead of every send, mention or
   * not — a single gate every send path routes through rather than
   * each caller tracking its own timer. */
  async function paceSend(): Promise<void> {
    const now = Date.now();
    if (now < nextSendAllowedAt) await Bun.sleep(nextSendAllowedAt - now);
    nextSendAllowedAt =
      Math.max(Date.now(), nextSendAllowedAt) + MIN_SEND_INTERVAL_MS;
  }

  async function countRunningTurns(): Promise<number> {
    const turns = await listTurns(stack);
    return turns.filter((t) => t.status === "running").length;
  }

  /** Backpressure gate a mention-bearing send waits on: holds while
   * more than `MAX_PENDING_TURNS` turns are in flight, bounded so a
   * wedged inference host can never stall the campaign forever — past
   * the bound it proceeds anyway and leaves a note rather than hanging. */
  async function waitForPendingBudget(): Promise<void> {
    const deadline = Date.now() + PENDING_GATE_MAX_WAIT_MS;
    for (;;) {
      const pending = await countRunningTurns();
      if (pending <= MAX_PENDING_TURNS) return;
      if (Date.now() > deadline) {
        notes.push(
          `pending-turn backpressure gate saturated (>${MAX_PENDING_TURNS} running turns) ` +
            `after ${PENDING_GATE_MAX_WAIT_MS}ms; proceeded anyway at ${messagesSent} messages`,
        );
        return;
      }
      await Bun.sleep(2000);
    }
  }

  function actorCookies(actorKey: string): string[] {
    const actor = stack.actors.get(actorKey);
    if (actor === undefined) {
      throw new Error(`plan names unknown actor "${actorKey}"`);
    }
    return actor.cookies;
  }

  function agentHandle(agentKey: string): string {
    const agent = agents.get(agentKey);
    if (agent === undefined)
      throw new Error(`plan names unknown agent "${agentKey}"`);
    return agent.handle;
  }

  /** Sends one `say`/`burst` line and folds latency/failure bookkeeping.
   * Returns the sent message id, or `undefined` on a recorded failure —
   * the caller decides whether that failure is fatal (see the
   * consecutive-failure abort below, applied only for `say`/`burst`). */
  async function recordSend(
    actorKey: string,
    text: string,
    ref?: string,
    inReplyToRef?: string,
  ): Promise<string | undefined> {
    const inReplyToMessageId =
      inReplyToRef === undefined ? undefined : refs.get(inReplyToRef);
    await paceSend();
    const result = await postMessage(
      stack,
      actorCookies(actorKey),
      text,
      inReplyToMessageId,
    );
    if ("error" in result) {
      counters.sendFailures += 1;
      consecutiveSendFailures += 1;
      if (consecutiveSendFailures >= CONSECUTIVE_SEND_FAILURE_ABORT) {
        throw new Error(
          `aborting: ${consecutiveSendFailures} consecutive send failures, latest: ${result.error}`,
        );
      }
      return undefined;
    }
    consecutiveSendFailures = 0;
    messagesSent += 1;
    window.sendLatenciesMs.push(result.latencyMs);
    if (ref !== undefined) refs.set(ref, result.id);
    return result.id;
  }

  /** A `say`'s mention fan-out: fires the mention and, on every 10th
   * mention seen this campaign, polls the mentioned agent's turn to
   * completion and samples its latency. Never blocks the ordinary
   * conversational pace on the other 9 — every mentioned agent is a
   * real model now, so waiting on every single one would defeat the
   * campaign's own send-rate pacing; this samples degradation instead
   * of measuring every reply. */
  async function sampleMentionTurn(messageId: string): Promise<void> {
    mentionsSeen += 1;
    if (mentionsSeen % 10 !== 0) return;
    const turn = await waitForTurnSettled(
      stack,
      messageId,
      MENTION_TURN_POLL_TIMEOUT_MS,
    );
    if (turn === undefined) {
      counters.turnFailures += 1;
      defects.push({
        severity: "S2",
        title: "sampled mention turn timed out",
        detail: `no settled turn within ${MENTION_TURN_POLL_TIMEOUT_MS}ms`,
        atMessages: messagesSent,
      });
      return;
    }
    if (turn.status === "failed") counters.turnFailures += 1;
    window.turnLatenciesMs.push(turnLatencyMs(turn));
  }

  async function realTurn(
    actorKey: string,
    agentKey: string,
    text: string,
    verb: string,
  ): Promise<AgentTurnRow | undefined> {
    const handle = agentHandle(agentKey);
    const mentionText = `@${handle} ${text}`;
    await waitForPendingBudget();
    await paceSend();
    const result = await postMessage(
      stack,
      actorCookies(actorKey),
      mentionText,
    );
    if ("error" in result) {
      counters.sendFailures += 1;
      defects.push({
        severity: "S1",
        title: `${verb} send failed for @${handle}`,
        detail: result.error,
        atMessages: messagesSent,
      });
      return undefined;
    }
    messagesSent += 1;
    window.sendLatenciesMs.push(result.latencyMs);

    const turn = await waitForTurnSettled(
      stack,
      result.id,
      REAL_TURN_POLL_TIMEOUT_MS,
    );
    if (turn === undefined) {
      counters.turnFailures += 1;
      defects.push({
        severity: "S1",
        title: `${verb} turn timed out for @${handle}`,
        detail: `no settled turn within ${REAL_TURN_POLL_TIMEOUT_MS}ms`,
        atMessages: messagesSent,
      });
      return undefined;
    }
    if (turn.status === "failed") {
      counters.turnFailures += 1;
      defects.push({
        severity: "S2",
        title: `${verb} turn failed for @${handle}`,
        detail: turn.id,
        atMessages: messagesSent,
      });
    } else {
      window.turnLatenciesMs.push(turnLatencyMs(turn));
    }
    return turn;
  }

  const firstActorKey = [...stack.actors.keys()][0];
  if (firstActorKey === undefined) {
    throw new Error("executeCampaign: stack has no actors");
  }
  const ownerActorKey: string = firstActorKey;

  async function runStep(step: PlanStep): Promise<void> {
    hooks?.onProgress?.({ atMessages: messagesSent, kind: step.kind });
    switch (step.kind) {
      case "say": {
        const mentionKeys = step.mentions ?? [];
        const text =
          mentionKeys.length === 0
            ? step.text
            : `${mentionKeys.map((key) => `@${agentHandle(key)}`).join(" ")} ${step.text}`;
        if (mentionKeys.length > 0) await waitForPendingBudget();
        const messageId = await recordSend(
          step.actor,
          text,
          step.ref,
          step.inReplyToRef,
        );
        if (messageId !== undefined && mentionKeys.length > 0) {
          await sampleMentionTurn(messageId);
        }
        return;
      }
      case "burst": {
        await Promise.all(
          step.sends.map((send) => recordSend(send.actor, send.text)),
        );
        return;
      }
      case "realTurn": {
        await realTurn(step.actor, step.agent, step.text, "realTurn");
        return;
      }
      case "routineAdvance": {
        const entries = [...stack.routines.values()];
        if (entries.length === 0) return;
        const advanceIndex = step.simDay % entries.length;
        for (let i = 0; i < entries.length; i++) {
          const routine = entries[i];
          if (routine === undefined) continue;
          if (i === advanceIndex) {
            const before = await api(
              stack.baseUrl,
              "GET",
              `/api/tenants/${stack.tenantId}/routines/${routine.id}/runs`,
              undefined,
              stack.ownerCookies,
            );
            expectStatus("routineAdvance: baseline runs", before, 200);
            const beforeIds = new Set(
              (
                arrayField(before.data, "items", "baseline runs") as {
                  runId: string;
                }[]
              ).map((r) => r.runId),
            );
            await stack.sql.unsafe(
              `UPDATE routines.routine SET next_fire_at = now() - interval '1 second' WHERE id = $1`,
              [routine.id],
            );
            counters.routineFiresTotal += 1;
            const deadline = Date.now() + ROUTINE_SCHEDULER_WAIT_MS;
            let accepted = false;
            while (Date.now() < deadline) {
              const after = await api(
                stack.baseUrl,
                "GET",
                `/api/tenants/${stack.tenantId}/routines/${routine.id}/runs`,
                undefined,
                stack.ownerCookies,
              );
              expectStatus("routineAdvance: polled runs", after, 200);
              const items = arrayField(after.data, "items", "polled runs") as {
                runId: string;
              }[];
              if (items.some((r) => !beforeIds.has(r.runId))) {
                accepted = true;
                break;
              }
              await Bun.sleep(1000);
            }
            if (accepted) counters.routineFiresAccepted += 1;
          } else {
            counters.routineFiresTotal += 1;
            const res = await api(
              stack.baseUrl,
              "POST",
              `/api/tenants/${stack.tenantId}/routines/${routine.id}/run`,
              {},
              stack.ownerCookies,
            );
            if (res.status === 201) counters.routineFiresAccepted += 1;
          }
        }
        return;
      }
      case "checkpoint": {
        // The record is labeled with the count this checkpoint fires
        // AT, not the count the window opened at — the window opened
        // at the previous checkpoint.
        window.atMessages = step.atMessages;
        const record = await collectCheckpoint(stack, window, counters);
        checkpoints.push(record);
        window = newCheckpointWindow(step.atMessages, startedAtMs);
        return;
      }
      case "restartHub": {
        await stack.restartHub();
        const recoveryStart = Date.now();
        let recovered = false;
        while (Date.now() - recoveryStart < RESTART_RECOVERY_WINDOW_MS) {
          await paceSend();
          const result = await postMessage(
            stack,
            stack.ownerCookies,
            `post-restart check ${crypto.randomUUID()}`,
          );
          if (!("error" in result)) {
            messagesSent += 1;
            window.sendLatenciesMs.push(result.latencyMs);
            recovered = true;
            break;
          }
          await Bun.sleep(1000);
        }
        const recoveryMs = Date.now() - recoveryStart;
        if (!recovered) {
          defects.push({
            severity: "S1",
            title: "hub restart recovery failed",
            detail: `no accepted send within ${RESTART_RECOVERY_WINDOW_MS}ms`,
            atMessages: messagesSent,
          });
        } else if (recoveryMs > RESTART_RECOVERY_DEFECT_THRESHOLD_MS) {
          defects.push({
            severity: "S2",
            title: "hub restart recovery slow",
            detail: `recovered after ${recoveryMs}ms`,
            atMessages: messagesSent,
          });
        }
        return;
      }
      case "providerSwitch": {
        if (stack.realTargets.length === 0) return;
        const realAgent = [...agents.values()].find((a) => a.real);
        if (realAgent === undefined) return;
        const nextTarget =
          stack.realTargets[providerSwitchIndex % stack.realTargets.length];
        providerSwitchIndex += 1;
        if (nextTarget === undefined) return;
        try {
          const redeployed = await stack.redeployAgent(realAgent.key, {
            targetLabel: nextTarget.label,
          });
          agents.set(realAgent.key, redeployed);
        } catch (error) {
          defects.push({
            severity: "S2",
            title: `providerSwitch failed for @${realAgent.handle}`,
            detail: error instanceof Error ? error.message : String(error),
            atMessages: messagesSent,
          });
          return;
        }
        const turn = await realTurn(
          ownerActorKey,
          realAgent.key,
          "confirm you're still online",
          "providerSwitch verify",
        );
        selfImprovement.push({
          name: `providerSwitch to ${nextTarget.label}`,
          pass: turn !== undefined && turn.status === "completed",
          detail: `model=${nextTarget.model}`,
        });
        return;
      }
      case "spawnAgent": {
        const spawnTarget = stack.realTargets[0];
        if (spawnTarget === undefined) {
          throw new Error(
            "spawnAgent: stack has no realTargets to pin the new agent at",
          );
        }
        let spawned: StackAgent;
        try {
          spawned = await stack.deployAgent({
            key: step.agentKey,
            handle: step.agentKey,
            name: `Spawned ${step.agentKey}`,
            systemPrompt:
              "You are a newly onboarded team member. Reply briefly and helpfully.",
            targetLabel: spawnTarget.label,
            skills: [],
          });
        } catch (error) {
          defects.push({
            severity: "S2",
            title: `spawnAgent deploy failed for ${step.agentKey}`,
            detail: error instanceof Error ? error.message : String(error),
            atMessages: messagesSent,
          });
          return;
        }
        const handle = spawned.handle;
        agents.set(step.agentKey, spawned);

        const turn = await realTurn(
          ownerActorKey,
          step.agentKey,
          "welcome aboard, please confirm you're online",
          "spawnAgent verify",
        );
        selfImprovement.push({
          name: `spawnAgent ${step.agentKey}`,
          pass: turn !== undefined && turn.status === "completed",
          detail: `handle=${handle}`,
        });
        return;
      }
      case "skillEdit": {
        const entry = [...stack.skillOwners.entries()][0];
        if (entry === undefined) {
          notes.push("skillEdit: no seeded skill to edit; step skipped");
          return;
        }
        const [skillName, owningAgentKey] = entry;
        const markerBody = `Always end every reply with the exact word ${step.marker}.`;
        const updated = await api(
          stack.baseUrl,
          "PUT",
          `/api/tenants/${stack.tenantId}/skills/${skillName}`,
          {
            description: "Longevity campaign self-improvement marker skill",
            body: markerBody,
          },
          stack.ownerCookies,
        );
        if (updated.status !== 200) {
          defects.push({
            severity: "S2",
            title: `skillEdit failed for ${skillName}`,
            detail: `expected 200, got ${updated.status}: ${JSON.stringify(updated.data)}`,
            atMessages: messagesSent,
          });
          return;
        }
        // The tenant skill row alone never reaches a turn (known
        // blocker D2/D3 drops tools/history on the openai-compatible
        // path), so the edit only lands once the owning agent's asset
        // is redeployed with the new body inlined — the same freeze
        // path a real re-publish takes.
        try {
          const redeployed = await stack.redeployAgent(owningAgentKey, {
            skillBody: { name: skillName, body: markerBody },
          });
          agents.set(owningAgentKey, redeployed);
        } catch (error) {
          defects.push({
            severity: "S2",
            title: `skillEdit redeploy failed for ${skillName}`,
            detail: error instanceof Error ? error.message : String(error),
            atMessages: messagesSent,
          });
        }
        return;
      }
      case "skillProbe": {
        const entry = [...stack.skillOwners.entries()][0];
        if (entry === undefined) {
          notes.push("skillProbe: no seeded skill owner; step skipped");
          return;
        }
        const [, agentKey] = entry;
        const turn = await realTurn(
          ownerActorKey,
          agentKey,
          "please respond so I can confirm your latest instructions",
          "skillProbe",
        );
        const knownBlockerNote =
          " (known blocker D2/D3: tools/history dropped on the " +
          "openai-compatible path — rule this out before treating a " +
          "failed probe as a new defect)";
        if (turn === undefined || turn.replyMessageId === null) {
          selfImprovement.push({
            name: `skillProbe ${step.marker}`,
            pass: false,
            detail: `no settled turn or reply message${knownBlockerNote}`,
          });
          return;
        }
        const replyText = await fetchMessageText(stack, turn.replyMessageId);
        const pass = replyText !== undefined && replyText.includes(step.marker);
        selfImprovement.push({
          name: `skillProbe ${step.marker}`,
          pass,
          detail: pass
            ? (replyText ?? "(no reply text found)")
            : `${replyText ?? "(no reply text found)"}${knownBlockerNote}`,
        });
        return;
      }
    }
  }

  for (const step of steps) {
    await runStep(step);
  }

  const wallHours = (Date.now() - startedAtMs) / 3_600_000;
  const messagesPerHour = wallHours > 0 ? messagesSent / wallHours : 0;
  notes.push(
    `sustained throughput: ${messagesPerHour.toFixed(2)} messages/hour ` +
      `(${messagesSent} persisted sends over ${wallHours.toFixed(2)}h)`,
  );

  return {
    name: `longevity-${startedAt.toISOString()}`,
    startedAt: startedAt.toISOString(),
    config,
    checkpoints,
    defects,
    knees: findKnees(checkpoints),
    selfImprovement,
    notes,
  };
}
