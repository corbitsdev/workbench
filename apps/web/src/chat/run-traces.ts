// Live progress stream and saved inference-step traces for a workbench's
// agents: folds SSE frames into an in-flight turn, and pairs saved inference
// steps with the replies they produced.

import { reportError } from "@corbits/error-sink";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import { useEffect } from "react";

import { workbenchKeys } from "../chat-path";
import { tenantKeys } from "../query-client";
import { sameAddress, type ChatAgent, type WorkbenchMessage } from "./threads-api";
import type { ReasoningPart, ToolTracePart } from "./wire/parts";
import {
  RunInferenceTurnsSchema,
  RunStreamFrameSchema,
  type RunStreamFrame,
  type RunStreamStatus,
  type SavedInferenceTurn,
  type SavedTurnPart,
} from "./wire/stream-events";

export type { RunStreamFrame, RunStreamStatus, SavedInferenceTurn, SavedTurnPart };

export type TracePart = ReasoningPart | ToolTracePart;

export type LiveTurn = {
  readonly status: RunStreamStatus;
  readonly startedAt: number;
  readonly committed: boolean;
  readonly text: string;
  readonly parts: readonly TracePart[];
  /** Index of the current step's reasoning part inside `parts`, or null. */
  readonly stepReasoningIndex: number | null;
  /** Maps `callId` to its index inside `parts` so `tool.result` updates it in place. */
  readonly toolIndexByCallId: Readonly<Record<string, number>>;
};

export function emptyLiveTurn(now = Date.now()): LiveTurn {
  return {
    status: "idle",
    startedAt: now,
    committed: false,
    text: "",
    parts: [],
    stepReasoningIndex: null,
    toolIndexByCallId: {},
  };
}

// Once a turn commits, the next step/delta/tool frame starts a fresh turn
// rather than appending onto the finished one.
function activeTurnOrReset(turn: LiveTurn, now: number): LiveTurn {
  return turn.committed ? emptyLiveTurn(now) : turn;
}

function applySnapshot(
  prev: LiveTurn,
  frame: Extract<RunStreamFrame, { type: "snapshot" }>,
): LiveTurn {
  const hadInFlight = prev.parts.length > 0 || prev.text.length > 0;
  const finishedWhileDisconnected =
    frame.status === "idle" && frame.text.length === 0 && hadInFlight;
  return {
    ...prev,
    status: frame.status,
    text: frame.text.length > 0 ? frame.text : prev.text,
    ...(finishedWhileDisconnected ? { committed: true, stepReasoningIndex: null } : {}),
  };
}

function appendReasoningDelta(turn: LiveTurn, token: string): LiveTurn {
  if (turn.stepReasoningIndex !== null) {
    const existing = turn.parts[turn.stepReasoningIndex];
    if (existing?.kind === "reasoning") {
      const parts = [...turn.parts];
      parts[turn.stepReasoningIndex] = {
        kind: "reasoning",
        text: existing.text + token,
      };
      return { ...turn, status: "busy", parts };
    }
  }
  return {
    ...turn,
    status: "busy",
    parts: [...turn.parts, { kind: "reasoning", text: token }],
    stepReasoningIndex: turn.parts.length,
  };
}

function backfillStepReasoning(turn: LiveTurn, reasoning: string | undefined): LiveTurn {
  if (reasoning === undefined || reasoning.length === 0 || turn.stepReasoningIndex !== null) {
    return { ...turn, stepReasoningIndex: null };
  }
  return {
    ...turn,
    parts: [...turn.parts, { kind: "reasoning", text: reasoning }],
    stepReasoningIndex: null,
  };
}

function appendToolCall(
  turn: LiveTurn,
  frame: Extract<RunStreamFrame, { type: "tool.call" }>,
): LiveTurn {
  if (turn.toolIndexByCallId[frame.callId] !== undefined) return turn;
  const index = turn.parts.length;
  const trace: ToolTracePart = {
    kind: "tool-trace",
    name: frame.name,
    input: frame.arguments,
    status: "running",
  };
  return {
    ...turn,
    status: "busy",
    parts: [...turn.parts, trace],
    toolIndexByCallId: { ...turn.toolIndexByCallId, [frame.callId]: index },
  };
}

function completeToolCall(
  turn: LiveTurn,
  frame: Extract<RunStreamFrame, { type: "tool.result" }>,
): LiveTurn {
  const index = turn.toolIndexByCallId[frame.callId];
  if (index === undefined) return turn;
  const current = turn.parts[index];
  if (current?.kind !== "tool-trace") return turn;
  const parts = [...turn.parts];
  parts[index] = {
    ...current,
    output: frame.content,
    status: frame.isError ? "error" : "success",
  };
  return { ...turn, parts };
}

/** Pure fold of one stream frame onto an agent's in-flight turn state. */
export function foldRunStreamFrame(prev: LiveTurn, frame: RunStreamFrame): LiveTurn {
  const now = Date.now();
  switch (frame.type) {
    case "snapshot":
      return applySnapshot(prev, frame);

    case "status":
      return { ...prev, status: frame.status };

    case "step.started":
      return {
        ...activeTurnOrReset(prev, now),
        status: "busy",
        committed: false,
        stepReasoningIndex: null,
      };

    case "reasoning.delta":
      return appendReasoningDelta(activeTurnOrReset(prev, now), frame.token);

    case "text.delta": {
      const base = activeTurnOrReset(prev, now);
      return { ...base, status: "busy", text: base.text + frame.token };
    }

    case "step.done":
      return backfillStepReasoning(prev, frame.reasoning);

    case "tool.call":
      return appendToolCall(activeTurnOrReset(prev, now), frame);

    case "tool.result":
      return completeToolCall(prev, frame);

    case "turn.committed":
      return {
        ...prev,
        status: "idle",
        committed: true,
        stepReasoningIndex: null,
      };

    default: {
      frame satisfies never;
      return prev;
    }
  }
}

/**
 * Keeps a live turn visible after `turn.committed` until the reply mail from
 * that agent lands in the timeline, so there is neither a duplicate reply nor
 * a blank gap between stream end and inbox refresh.
 */
export function liveTurnVisible(
  turn: LiveTurn | undefined,
  agentAddress: string,
  messages: readonly WorkbenchMessage[],
): boolean {
  if (turn === undefined) return false;
  const hasContent = turn.parts.length > 0 || turn.text.length > 0;
  if (!hasContent && turn.status === "idle") return false;
  const replyLanded = messages.some(
    (message) =>
      message.author === "other" &&
      sameAddress(message.address, agentAddress) &&
      Date.parse(message.at) >= turn.startedAt - 1000,
  );
  if (replyLanded && (turn.committed || turn.status === "idle")) return false;
  return true;
}

function savedTurnsToTraceParts(turns: readonly SavedInferenceTurn[]): TracePart[] {
  const parts: TracePart[] = [];
  const toolIndexByCallId = new Map<string, number>();

  for (const turn of turns) {
    for (const part of turn.parts) {
      switch (part.kind) {
        case "reasoning":
          parts.push({ kind: "reasoning", text: part.text });
          break;

        case "tool-call":
          toolIndexByCallId.set(part.callId, parts.length);
          parts.push({
            kind: "tool-trace",
            name: part.name,
            input: part.arguments,
            status: turn.status === "running" ? "running" : "success",
          });
          break;

        case "tool-result": {
          const index = toolIndexByCallId.get(part.callId);
          const current = index === undefined ? undefined : parts[index];
          if (index !== undefined && current?.kind === "tool-trace") {
            parts[index] = {
              ...current,
              output: part.content,
              status: part.isError ? "error" : "success",
            };
          }
          break;
        }

        case "error":
          break;

        default: {
          part satisfies never;
          break;
        }
      }
    }
  }
  return parts;
}

export type AgentSavedTurns = {
  readonly addresses: readonly string[];
  readonly turns: readonly SavedInferenceTurn[];
};

export type MatchedMessageTraces = {
  /** Keyed by `WorkbenchMessage.id`. */
  readonly byMessageId: ReadonlyMap<string, readonly TracePart[]>;
  /** Saved steps that started after an agent's latest reply, keyed by lowercased address. */
  readonly inFlight: ReadonlyMap<string, readonly TracePart[]>;
};

/**
 * Pairs each agent reply in the timeline with the saved inference steps that
 * ran between that agent's previous reply and this one. Steps started after
 * the last reply stay in `inFlight` so a reload mid-turn still shows completed
 * steps.
 */
export function tracesForMessages(
  messages: readonly WorkbenchMessage[],
  agents: readonly AgentSavedTurns[],
): MatchedMessageTraces {
  const byMessageId = new Map<string, readonly TracePart[]>();
  const inFlight = new Map<string, readonly TracePart[]>();

  for (const agent of agents) {
    if (agent.turns.length === 0 || agent.addresses.length === 0) continue;
    const sortedTurns = [...agent.turns].sort(
      (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
    );
    const replies = messages.filter(
      (message) =>
        message.author === "other" &&
        agent.addresses.some((addr) => sameAddress(addr, message.address)),
    );

    let cursor = 0;
    for (const reply of replies) {
      const replyMs = Date.parse(reply.at) + 2000;
      const bucket: SavedInferenceTurn[] = [];
      while (cursor < sortedTurns.length) {
        const candidate = sortedTurns[cursor];
        if (candidate === undefined || Date.parse(candidate.startedAt) > replyMs) {
          break;
        }
        bucket.push(candidate);
        cursor++;
      }
      const trace = savedTurnsToTraceParts(bucket);
      if (trace.length > 0) {
        byMessageId.set(reply.id, trace);
      }
    }

    const inFlightParts = savedTurnsToTraceParts(sortedTurns.slice(cursor));
    if (inFlightParts.length > 0) {
      for (const addr of agent.addresses) {
        inFlight.set(addr.toLowerCase(), inFlightParts);
      }
    }
  }

  return { byMessageId, inFlight };
}

function runStreamPath(tenantId: string, runId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/workflows/runs/${encodeURIComponent(runId)}/stream`;
}

function runInferenceTurnsPath(tenantId: string, runId: string): string {
  return `/api/tenants/${encodeURIComponent(tenantId)}/workflows/runs/${encodeURIComponent(runId)}/inference-turns`;
}

async function fetchRunInferenceTurns(
  tenantId: string,
  runId: string,
): Promise<readonly SavedInferenceTurn[]> {
  try {
    const response = await fetch(runInferenceTurnsPath(tenantId, runId), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return [];
    const parsed = RunInferenceTurnsSchema(await response.json().catch(() => undefined));
    if (parsed instanceof type.errors) return [];
    return parsed.turns;
  } catch (cause) {
    reportError(cause, { operation: "chat_fetch_inference_turns" });
    return [];
  }
}

export type LiveTurnsByAddress = Readonly<Record<string, LiveTurn>>;

/**
 * Subscribes to `/workflows/runs/:runId/stream` for every live agent in the
 * workbench and folds frames into the query cache.
 */
export function useWorkbenchRunStreams(
  workbenchTenantId: string,
  chatAgents: readonly ChatAgent[],
): LiveTurnsByAddress {
  const queryClient = useQueryClient();
  const liveTargets = chatAgents.flatMap((agent) =>
    agent.liveRunId !== null && agent.liveAddress !== null
      ? [{ runId: agent.liveRunId, address: agent.liveAddress.toLowerCase() }]
      : [],
  );
  const targetsKey = liveTargets.map((target) => `${target.runId}:${target.address}`).join(",");

  useEffect(() => {
    if (targetsKey.length === 0) return;
    const closers = liveTargets.map(({ runId, address }) => {
      const source = new EventSource(runStreamPath(workbenchTenantId, runId));
      const handler = (event: MessageEvent<string>) => {
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch (cause) {
          reportError(cause, { operation: "chat_run_stream_parse" });
          return;
        }
        const frame = RunStreamFrameSchema(raw);
        if (frame instanceof type.errors) return;

        queryClient.setQueryData<LiveTurnsByAddress>(
          workbenchKeys.liveTurns(workbenchTenantId),
          (current) => {
            const map = current ?? {};
            const prev = map[address] ?? emptyLiveTurn();
            return { ...map, [address]: foldRunStreamFrame(prev, frame) };
          },
        );

        if (frame.type === "status" && frame.status === "waiting_approval") {
          void queryClient.invalidateQueries({
            queryKey: tenantKeys.pendingApprovals(workbenchTenantId),
          });
        }
        if (frame.type === "turn.committed") {
          void queryClient.invalidateQueries({
            queryKey: workbenchKeys.savedTurns(workbenchTenantId, runId),
          });
          void queryClient.invalidateQueries({
            queryKey: workbenchKeys.scope(workbenchTenantId),
          });
        }
      };
      source.addEventListener("run", handler as EventListener);
      return () => {
        source.removeEventListener("run", handler as EventListener);
        source.close();
      };
    });
    return () => {
      for (const close of closers) close();
    };
    // `targetsKey` serializes `liveTargets`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbenchTenantId, targetsKey, queryClient]);

  const liveTurns = useQuery<LiveTurnsByAddress>({
    queryKey: workbenchKeys.liveTurns(workbenchTenantId),
    queryFn: () => ({}),
    enabled: false,
    gcTime: Infinity,
  });
  return liveTurns.data ?? {};
}

/**
 * Reads saved inference steps for every run any agent in the workbench has
 * ever executed under, and pairs them with the timeline's replies.
 */
export function useWorkbenchSavedTraces(
  workbenchTenantId: string,
  chatAgents: readonly ChatAgent[],
  messages: readonly WorkbenchMessage[],
): MatchedMessageTraces {
  const runTargets = chatAgents.flatMap((agent) =>
    agent.runIds.map((runId) => ({ runId, addresses: agent.addresses })),
  );
  const queries = useQueries({
    queries: runTargets.map(({ runId }) => ({
      queryKey: workbenchKeys.savedTurns(workbenchTenantId, runId),
      queryFn: () => fetchRunInferenceTurns(workbenchTenantId, runId),
    })),
  });

  const byAgent = new Map<readonly string[], SavedInferenceTurn[]>();
  runTargets.forEach((target, index) => {
    const turns = queries[index]?.data;
    if (turns === undefined || turns.length === 0) return;
    const list = byAgent.get(target.addresses) ?? [];
    list.push(...turns);
    byAgent.set(target.addresses, list);
  });

  const agentInputs: AgentSavedTurns[] = [...byAgent.entries()].map(([addresses, turns]) => ({
    addresses,
    turns,
  }));
  return tracesForMessages(messages, agentInputs);
}
