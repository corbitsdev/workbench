// The spike room's living run and its per-message turns (CL-6323 Phase 0).
//
// A room opens as rows alone — no deploy. The run is deployed lazily, once,
// on the room's first message, and stays warm: its single `onTrigger`
// section services every later message as another occurrence, each
// occurrence its own child run with its own run id and event log. A reply
// carries that child run id, which is what makes a turn addressable at
// all — the production chat path's replies carry none.

import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable } from "@intx/db/schema";
import { resolveDefinitionSources } from "@intx/hub-api";
import { listDefaultInferencePreferences } from "../inference-preferences";
import { ensureWorkflowDefinitionForAsset } from "@intx/hub-sessions";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import type { AssetService, SidecarEventEmitter } from "@intx/hub-sessions";
import { formatRunAddress } from "@intx/types";
import type { CryptoProvider } from "@intx/types/runtime";
import { computeWireDefinitionHash } from "@intx/types/wire-definition-hash";

import { connectorReplyContent, messageRunEnded } from "@corbits/folded-runs";
import {
  SPIKE_ROOM_SECTION_ID,
  buildSpikeRoomWorkflow,
  spikeTurnChildRunId,
} from "./room-workflow";
import type { SpikeMessage, SpikeRoom, SpikeRoomStore } from "./room-store";

const log = getLogger(["chat", "spike", "room-run"]);

/** How many prior messages a turn is given as context. Spike-hardcoded. */
const CONTEXT_MESSAGES = 30;

export type SpikeRoomEvent =
  | { readonly type: "room.message"; readonly data: SpikeMessage }
  | {
      readonly type: "room.turn";
      readonly data: {
        readonly turnId: string;
        readonly childRunId: string;
        readonly phase: "started" | "delta" | "ended";
        readonly text?: string;
        readonly status?: "completed" | "failed";
      };
    };

export type SpikeRoomRunDeps = {
  readonly db: DB["db"];
  readonly store: SpikeRoomStore;
  readonly assetService: AssetService;
  readonly events: SidecarEventEmitter;
  readonly sessionService: {
    deployWorkflowDefinition(params: {
      tenantId: string;
      anchorRunId: string;
      deploymentDomain: string;
      definition: ReturnType<typeof buildSpikeRoomWorkflow>;
      definitionAssetId: string;
      config: Record<string, unknown>;
      deployContent: { systemPrompt: string };
    }): Promise<{ anchorRunId: string; deploymentAddress: string }>;
    sendUserMessage(params: {
      agentAddress: string;
      from: string;
      messageId: string;
      date: Date;
      content: string;
      sessionId: string;
      tenantId: string;
      cryptoProvider: CryptoProvider;
    }): Promise<Uint8Array>;
  };
  readonly eventCollectors: {
    create(
      address: string,
      tenantId: string,
      sessionId: string,
      instanceId: string,
    ): unknown;
  };
  readonly cryptoProviders: { get(instanceId: string): Promise<CryptoProvider> };
  readonly credentialCipher?: Parameters<
    typeof resolveDefinitionSources
  >[0]["credentialCipher"];
  readonly publish: (roomId: string, event: SpikeRoomEvent) => void;
  readonly turnTimeoutMs: number;
};

export class SpikeRoomLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpikeRoomLaunchError";
  }
}

/** Occurrence counter per room run, so a turn knows its child run id. */
const occurrencesByRoom = new Map<string, number>();

/**
 * Deploys the room's living run if it has none yet, and returns the
 * routing identity every later turn reuses. Idempotent per room row: a
 * room that already carries a run id is returned as-is, so only the
 * first message pays the deploy.
 */
export async function ensureRoomRun(
  deps: SpikeRoomRunDeps,
  room: SpikeRoom,
  deployerPrincipalId: string,
): Promise<{ runId: string; address: string; sessionId: string }> {
  if (room.runId !== null && room.address !== null && room.sessionId !== null) {
    return {
      runId: room.runId,
      address: room.address,
      sessionId: room.sessionId,
    };
  }

  const tenantRow = await deps.db.query.tenant.findFirst({
    where: eq(tenantTable.id, room.tenantId),
  });
  if (tenantRow === undefined) {
    throw new SpikeRoomLaunchError(`No tenant "${room.tenantId}"`);
  }

  // The room's agent declares no model of its own, so it resolves against
  // the tenant's own default the same way a workbench host does.
  const [tenantDefault] = await listDefaultInferencePreferences(
    deps.db,
    room.tenantId,
  );
  const resolution = await resolveDefinitionSources({
    db: deps.db,
    tenantId: room.tenantId,
    modelRequirements: null,
    fallbackModel: tenantDefault?.model ?? null,
    invokerPreferences: {},
    ...(deps.credentialCipher !== undefined
      ? { credentialCipher: deps.credentialCipher }
      : {}),
  });
  if (!resolution.ok) {
    throw new SpikeRoomLaunchError(
      `cannot resolve an inference source for the spike room (${resolution.message})`,
    );
  }

  const runId = generateId("workflowRun");
  const address = formatRunAddress(runId, tenantRow.domain);
  const sessionId = generateId("session");
  const definition = buildSpikeRoomWorkflow({
    roomRunId: runId,
    triggerAddress: address,
    systemPrompt: room.systemPrompt,
    // The section body's agent declares the resolved chain, which is what
    // the deploy's capability walk turns into the approved source set.
    inferencePreferences: resolution.sources.map((source) => ({
      provider: source.provider,
      model: source.model,
    })),
    turnTimeoutMs: deps.turnTimeoutMs,
  });

  const asset = await deps.assetService.createAsset({
    tenantId: room.tenantId,
    kind: "workflow",
    name: `spike-room-${room.id}`,
  });
  await ensureWorkflowDefinitionForAsset(deps.db, {
    assetId: asset.id,
    wireHash: await computeWireDefinitionHash(definition),
  });

  deps.eventCollectors.create(address, room.tenantId, sessionId, runId);

  await deps.sessionService.deployWorkflowDefinition({
    tenantId: room.tenantId,
    anchorRunId: runId,
    deploymentDomain: tenantRow.domain,
    definition,
    definitionAssetId: asset.id,
    config: {
      sessionId,
      agentId: runId,
      tenantId: room.tenantId,
      principalId: deployerPrincipalId,
      agentAddress: address,
      systemPrompt: room.systemPrompt,
      tools: [],
      grants: [],
      sources: resolution.sources,
      defaultSource: resolution.defaultSource,
    },
    deployContent: { systemPrompt: room.systemPrompt },
  });

  await deps.store.attachRun(room.id, { runId, address, sessionId });
  occurrencesByRoom.set(runId, 0);
  return { runId, address, sessionId };
}

export type DispatchedTurn = {
  readonly turnId: string;
  readonly childRunId: string;
  readonly roomRunId: string;
};

/**
 * Runs one turn: the room's next occurrence. Never awaited on the request
 * path — the message row and its publish already happened.
 */
export async function dispatchTurn(
  deps: SpikeRoomRunDeps,
  input: {
    room: SpikeRoom;
    requestMessageId: string;
    senderAddress: string;
    deployerPrincipalId: string;
  },
): Promise<DispatchedTurn> {
  const run = await ensureRoomRun(deps, input.room, input.deployerPrincipalId);
  const occurrence = occurrencesByRoom.get(run.runId) ?? 0;
  occurrencesByRoom.set(run.runId, occurrence + 1);
  const childRunId = spikeTurnChildRunId(occurrence);
  const turnId = `${run.runId}:${childRunId}`;

  await deps.store.insertTurn({
    id: turnId,
    roomId: input.room.id,
    tenantId: input.room.tenantId,
    requestMessageId: input.requestMessageId,
    childRunId,
  });
  deps.publish(input.room.id, {
    type: "room.turn",
    data: { turnId, childRunId, phase: "started" },
  });

  const history = await deps.store.listMessages(input.room.id, CONTEXT_MESSAGES);
  const prompt = history
    .map((message) => `${message.authorKind}: ${message.body}`)
    .join("\n");

  let accumulated = "";
  let settled = false;
  const unsubscribe = deps.events.on(
    "agent.event",
    ({ agentAddress, event }) => {
      if (agentAddress !== run.address || settled) return;

      const delta = deltaText(event);
      if (delta !== undefined) {
        deps.publish(input.room.id, {
          type: "room.turn",
          data: { turnId, childRunId, phase: "delta", text: delta },
        });
        return;
      }
      const reply = connectorReplyContent(event);
      if (reply !== undefined) {
        accumulated += reply;
        return;
      }
      const ended = messageRunEnded(event);
      if (ended === undefined) return;
      settled = true;
      unsubscribe();
      void finish(ended.status, ended.errorMessage);
    },
  );

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    unsubscribe();
    void finish("failed", `turn exceeded ${String(deps.turnTimeoutMs)}ms`);
  }, deps.turnTimeoutMs);

  async function finish(
    status: "completed" | "failed",
    errorMessage: string | undefined,
  ): Promise<void> {
    clearTimeout(timer);
    const body =
      status === "completed"
        ? accumulated
        : `This turn did not finish (${errorMessage ?? "unknown reason"}).`;
    const message = await deps.store.insertMessage({
      id: generateId("workflowRun"),
      roomId: input.room.id,
      tenantId: input.room.tenantId,
      authorKind: "agent",
      authorId: run.address,
      body,
      runId: childRunId,
    });
    await deps.store.finishTurn({
      id: turnId,
      status: status === "completed" ? "completed" : "failed",
      replyMessageId: message.id,
    });
    deps.publish(input.room.id, { type: "room.message", data: message });
    deps.publish(input.room.id, {
      type: "room.turn",
      data: { turnId, childRunId, phase: "ended", status },
    });
  }

  const cryptoProvider = await deps.cryptoProviders.get(run.runId);
  try {
    await deps.sessionService.sendUserMessage({
      agentAddress: run.address,
      from: input.senderAddress,
      messageId: `<${input.requestMessageId}@spike>`,
      date: new Date(),
      content: prompt,
      sessionId: run.sessionId,
      tenantId: input.room.tenantId,
      cryptoProvider,
    });
  } catch (cause) {
    if (!settled) {
      settled = true;
      unsubscribe();
      await finish(
        "failed",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    log.error`spike room ${input.room.id} turn ${turnId} send failed`;
  }

  return { turnId, childRunId, roomRunId: run.runId };
}

/** The cumulative text of an `inference.text.delta`, or undefined. */
function deltaText(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const record = event as Record<string, unknown>;
  if (record["type"] !== "inference.text.delta") return undefined;
  const data = record["data"];
  if (typeof data !== "object" || data === null) return undefined;
  const partial = (data as Record<string, unknown>)["partial"];
  if (typeof partial !== "object" || partial === null) return undefined;
  const text = (partial as Record<string, unknown>)["text"];
  return typeof text === "string" ? text : undefined;
}

export { SPIKE_ROOM_SECTION_ID };
