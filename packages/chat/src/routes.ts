// The full HTTP surface of `@corbits/chat`: channel lifecycle, message
// send/list, settings, read-state, typing, and the SSE stream — mounted
// by the hub inside its tenant-scoped middleware, so `TenantEnv`'s
// `tenant`/`principal` are always resolved before a handler here runs.
// Principals never appear in a path; the caller is always read off
// context.
//
// This module owns route registration, request parsing (arktype at
// the boundary), grant checks, and HTTP envelope mapping only — every
// other concern lives in its own module: the platform port in
// `./platform-port`, the settings vocabulary in `./channel-settings`,
// join/fan-out orchestration in `./channel-service`, and the SSE
// subscriber registry in `./channel-events`.
import { formatAgentAddress } from "@intx/types";
import type { InferencePreference } from "@intx/agent";
import { generateId } from "@intx/hub-common";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type } from "arktype";

import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";

import { decodeMail, encodeParts, senderOf } from "./codec";
import { Part, type Part as PartType } from "./parts";
import { presetForKind } from "./kinds";
import { localPartOf } from "./agent-address";
import { parseParticipants, addParticipant } from "./participants";
import type { ParticipantRecord } from "./participants";
import {
  buildChannelHostWorkflow,
  serializeChannelHostWorkflow,
} from "./channel-workflow";
import {
  CHANNEL_CONTROL_NAMESPACE,
  applyControlPayload,
  type ChannelControlPayload,
  type ChannelParticipantState,
} from "./settings-control";
import {
  channelView,
  kindOf,
  participantsOf,
  SettingsValidationError,
  validateSettingsPatch,
} from "./channel-settings";
import { launchAndJoinAgent, sendChannelMessage } from "./channel-service";
import {
  bridgeChannelStream,
  createChannelSubscriberRegistry,
} from "./channel-events";
import type { ChatPlatform } from "./platform-port";
import type { ChatStore } from "./store";

export type {
  ChannelEvents,
  ChannelLauncher,
  ChannelMail,
  ChatChannelEvent,
  ChatPlatform,
  InvitableDefinition,
  LaunchedChannel,
  LaunchedInvite,
  ListedMail,
  ListedMailItem,
  SentMail,
} from "./platform-port";

export type CreateChatRoutesDeps = {
  store: ChatStore;
  platform: ChatPlatform;
  requireGrant: RequireGrant;
  /** Per-occurrence timeout for the channel host's step. */
  turnTimeoutMs: number;
  /**
   * The provider/model chain the channel host's definition declares.
   * A folded interactive-instance launch resolves and pins a real
   * inference source chain against the tenant catalog before it will
   * launch at all (see `platform-adapter.ts`), so this must name a
   * model a seeded catalog source can resolve — omitting it is valid
   * up front, but `launchChannel` then fails loud at creation time.
   */
  channelHostInferencePreferences?: readonly InferencePreference[];
};

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const CreateChannelBody = type({
  kind: "string",
  "name?": "string",
  "participants?": "string[]",
  "definitionId?": "string",
});
type CreateChannelBodyT = typeof CreateChannelBody.infer;

/**
 * Narrows a validated create-channel body to the "chat with a
 * definitionId" shape, letting the type system carry the proof
 * `definitionId` is present rather than a `throw new
 * Error("unreachable")` after the fact — the route already 400s above
 * when `kind === "chat"` and `definitionId` is absent, so this guard
 * fails into an ordinary response, never a thrown "impossible" error,
 * if that invariant is ever broken by a future edit.
 */
function isChatWithDefinition(
  body: CreateChannelBodyT,
): body is CreateChannelBodyT & { kind: "chat"; definitionId: string } {
  return body.kind === "chat" && body.definitionId !== undefined;
}

const InviteAgentBody = type({
  definitionId: "string",
});

const PutReadStateBody = type({
  lastSeenCreatedAt: "string",
  lastSeenId: "string",
});

export function createChatRoutes(deps: CreateChatRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const registry = createChannelSubscriberRegistry();
  const publish = registry.publish;

  app.post(
    "/channels",
    deps.requireGrant("workflow-run:*", "create"),
    async (c) => {
      const body = CreateChannelBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid channel body: ${body.summary}`),
          400,
        );
      }

      if (body.kind === "chat" && body.definitionId === undefined) {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            "creating a chat requires a definitionId naming the single " +
              "agent it launches with",
          ),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");

      const channelId = generateId("instance");
      const triggerAddress = formatAgentAddress(channelId, tenant.domain);
      const definition = serializeChannelHostWorkflow(
        buildChannelHostWorkflow({
          triggerAddress,
          inferencePreferences: deps.channelHostInferencePreferences ?? [],
          turnTimeoutMs: deps.turnTimeoutMs,
        }),
      );

      await deps.platform.launchChannel({
        tenantId: tenant.id,
        creatorPrincipalId: principal.id,
        channelId,
        triggerAddress,
        definition,
      });

      const preset = presetForKind(body.kind);
      // Initial participants arrive as bare addresses; each gets a
      // handle derived from its own local part, de-duplicated the same
      // way an invited agent's handle is (see `POST .../invite` below)
      // — settings always hold records, never bare strings.
      const initialParticipants = (body.participants ?? []).reduce<
        ParticipantRecord[]
      >(
        (acc, address) => addParticipant(acc, address, localPartOf(address)),
        [],
      );
      const settings: Record<string, unknown> = {
        "chat/kind": body.kind,
        "chat/pinned": preset.pinned,
        "chat/participants": initialParticipants,
        ...(body.name !== undefined ? { "chat/name": body.name } : {}),
      };

      const row = await deps.store.createChannelSettings({
        tenantId: tenant.id,
        channelId,
        settings,
        updatedBy: principal.id,
      });

      if (!isChatWithDefinition(body)) {
        return c.json(channelView(row), 201);
      }

      // A chat's agent is chosen at creation, not invited later: the
      // same launch-and-join core `POST .../invite` uses, run inline
      // here so the chat comes back from this single call already
      // carrying its one agent participant.
      const joined = await launchAndJoinAgent(
        { store: deps.store, platform: deps.platform, publish },
        {
          tenantId: tenant.id,
          principalId: principal.id,
          channelId,
          definitionId: body.definitionId,
          existingSettings: row.settings,
        },
      );

      // The chat's default title, when the caller passes no name, is
      // its agent's handle.
      const finalSettings =
        body.name === undefined
          ? (
              await deps.store.updateChannelSettings({
                tenantId: tenant.id,
                channelId,
                settings: { ...joined.settings, "chat/name": joined.handle },
                updatedBy: principal.id,
              })
            ).settings
          : joined.settings;

      return c.json(channelView({ channelId, settings: finalSettings }), 201);
    },
  );

  app.get(
    "/channels",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const kind = c.req.query("kind");
      const rows = await deps.store.listChannelSettings(tenant.id, kind);
      return c.json({ items: rows.map(channelView) });
    },
  );

  app.get(
    "/channels/:id/messages",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const channelId = c.req.param("id");
      const cursor = c.req.query("cursor");

      const listed = await deps.platform.listMail({
        tenantId: tenant.id,
        channelId,
        ...(cursor !== undefined ? { cursor } : {}),
      });

      const items = await Promise.all(
        listed.items.map(async (item) => ({
          id: item.id,
          createdAt: item.createdAt,
          sender: senderOf(item.mail),
          parts: await decodeMail(item.mail, {
            fetchBlob: (blobId) => deps.platform.fetchBlob(channelId, blobId),
          }),
        })),
      );

      return c.json({
        items,
        ...(listed.nextCursor !== undefined
          ? { nextCursor: listed.nextCursor }
          : {}),
      });
    },
  );

  app.post(
    "/channels/:id/messages",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const raw = await c.req.json().catch(() => undefined);
      const parsed = Part.array()(raw);
      if (parsed instanceof type.errors) {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            `invalid message body: ${parsed.summary}`,
          ),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const channelId = c.req.param("id");
      const messageParts = parsed as PartType[];

      const sent = await sendChannelMessage(
        { store: deps.store, platform: deps.platform },
        {
          tenantId: tenant.id,
          principalId: principal.id,
          channelId,
          messageParts,
        },
      );

      return c.json({ id: sent.id, createdAt: sent.createdAt }, 201);
    },
  );

  app.get(
    "/channels/:id/invitable",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const items = await deps.platform.listInvitableDefinitions(tenant.id);
      return c.json({ items });
    },
  );

  app.post(
    "/channels/:id/invite",
    deps.requireGrant("workflow-run:*", "create"),
    async (c) => {
      const body = InviteAgentBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid invite body: ${body.summary}`),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const channelId = c.req.param("id");

      const existing = await deps.store.getChannelSettings(
        tenant.id,
        channelId,
      );
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }

      if (kindOf(existing.settings) === "chat") {
        return c.json(
          ErrorEnvelope(
            "conflict",
            "a chat has exactly one agent, fixed at creation; invite is " +
              "only for channels",
          ),
          409,
        );
      }

      const joined = await launchAndJoinAgent(
        { store: deps.store, platform: deps.platform, publish },
        {
          tenantId: tenant.id,
          principalId: principal.id,
          channelId,
          definitionId: body.definitionId,
          existingSettings: existing.settings,
        },
      );

      return c.json(
        { address: joined.address, definitionId: joined.definitionId },
        201,
      );
    },
  );

  app.get(
    "/channels/:id/settings",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const channelId = c.req.param("id");
      const row = await deps.store.getChannelSettings(tenant.id, channelId);
      if (row === undefined) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }
      return c.json({ ...channelView(row), settings: row.settings });
    },
  );

  app.patch(
    "/channels/:id/settings",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const channelId = c.req.param("id");

      const existing = await deps.store.getChannelSettings(
        tenant.id,
        channelId,
      );
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }

      let patch: Record<string, unknown>;
      try {
        patch = validateSettingsPatch(
          await c.req.json().catch(() => undefined),
        );
      } catch (err) {
        if (err instanceof SettingsValidationError) {
          return c.json(ErrorEnvelope("bad_request", err.message), 400);
        }
        throw err;
      }

      // `chat/participants` is normalized to records on write even when
      // a caller PATCHes it with bare addresses (as the settings-control
      // wire path does) — settings always hold records, never strings.
      const merged: Record<string, unknown> = {
        ...existing.settings,
        ...patch,
        ...(patch["chat/participants"] !== undefined
          ? {
              "chat/participants": parseParticipants(
                patch["chat/participants"],
              ),
            }
          : {}),
      };
      // The settings record itself is the durable source of truth; it
      // is updated before anything else here fires, so a failure
      // below never leaves the record unwritten and the audit trail
      // silently ahead of it.
      const row = await deps.store.updateChannelSettings({
        tenantId: tenant.id,
        channelId,
        settings: merged,
        updatedBy: principal.id,
      });

      // The audit trail lives in the anchor's own timeline: fold the
      // patch through the same control/settings logic the old relay
      // workflow used, then post each resulting event part into the
      // anchor's mailbox. A failure here is loud (unhandled), never
      // swallowed, since the timeline is the record of what changed.
      const priorState: ChannelParticipantState = {
        participants: participantsOf(existing.settings).map(
          (participant) => participant.address,
        ),
        settings: existing.settings,
      };
      const controlPayload: ChannelControlPayload = {
        namespace: CHANNEL_CONTROL_NAMESPACE,
        settings: patch,
        ...(patch["chat/participants"] !== undefined
          ? {
              participants: parseParticipants(patch["chat/participants"]).map(
                (participant) => participant.address,
              ),
            }
          : {}),
      };
      const { events } = applyControlPayload(
        priorState,
        controlPayload,
        principal.id,
      );
      for (const event of events) {
        await deps.platform.sendMail({
          tenantId: tenant.id,
          channelId,
          principalId: principal.id,
          content: encodeParts([event]),
        });
      }

      publish(channelId, {
        type: "chat.settings",
        data: { updatedBy: principal.id, settings: row.settings },
      });

      return c.json({ ...channelView(row), settings: row.settings });
    },
  );

  app.get(
    "/channels/:id/read-state",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const channelId = c.req.param("id");
      const row = await deps.store.getReadState(
        tenant.id,
        channelId,
        principal.id,
      );
      if (row === undefined) {
        return c.json({ lastSeenCreatedAt: null, lastSeenId: null });
      }
      return c.json({
        lastSeenCreatedAt: row.lastSeenCreatedAt.toISOString(),
        lastSeenId: row.lastSeenId,
      });
    },
  );

  app.put(
    "/channels/:id/read-state",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const body = PutReadStateBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope(
            "bad_request",
            `invalid read-state body: ${body.summary}`,
          ),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const channelId = c.req.param("id");

      const row = await deps.store.putReadState({
        tenantId: tenant.id,
        channelId,
        principalId: principal.id,
        lastSeenCreatedAt: new Date(body.lastSeenCreatedAt),
        lastSeenId: body.lastSeenId,
      });

      return c.json({
        lastSeenCreatedAt: row.lastSeenCreatedAt.toISOString(),
        lastSeenId: row.lastSeenId,
      });
    },
  );

  app.post(
    "/channels/:id/typing",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    (c) => {
      const principal = c.get("principal");
      const channelId = c.req.param("id");
      publish(channelId, {
        type: "chat.typing",
        data: { principalId: principal.id },
      });
      return c.body(null, 202);
    },
  );

  app.get(
    "/channels/:id/stream",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const channelId = c.req.param("id");

      return streamSSE(c, async (stream) => {
        const unbridge = bridgeChannelStream({
          registry,
          platform: deps.platform,
          channelId,
          stream,
        });
        stream.onAbort(unbridge);
        await new Promise<void>(() => undefined);
      });
    },
  );

  return app;
}
