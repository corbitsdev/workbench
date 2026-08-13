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
import { getLogger } from "@intx/log";
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
  benchContextWindowOf,
  channelView,
  kindOf,
  participantsOf,
  resolveContextWindow,
  SettingsValidationError,
  validateBenchSettingsPatch,
  validateSettingsPatch,
} from "./channel-settings";
import { launchAndJoinAgent, sendChannelMessage } from "./channel-service";
import {
  bridgeChannelStream,
  createChannelSubscriberRegistry,
} from "./channel-events";
import type { ChatPlatform } from "./platform-port";
import type { ChatStore } from "./store";
import {
  dispatchAtCommand,
  dispatchSlashCommand,
  resolveAtCommand,
} from "@corbits/commands";
import type { CommandRegistry, CommandResult } from "@corbits/commands";
import { InferenceResolutionError } from "@corbits/folded-runs";
import type { ChannelTenancyStore } from "./channel-tenancy";
import type { ThreadStore } from "./threads";

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
  /**
   * Mints and tracks the native child tenant every channel is anchored
   * as (see `./channel-tenancy.ts`) — required, never optional: a
   * channel created without a tenancy would be a silent legacy path
   * reopened, which "no fallbacks" forbids. Every channel created
   * through this route carries a tenancy link from creation onward;
   * only channels that predate this rollout lack one.
   */
  tenancy: ChannelTenancyStore;
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
  /**
   * Thread identity store (root / reply / delivery). When omitted,
   * thread list routes return empty and delivery-thread creation is
   * unavailable — composition that wants threads (hub) injects a
   * real store. Optional so unit tests that only exercise channel
   * CRUD stay free of thread tables.
   */
  threads?: ThreadStore;
  /**
   * The `/name args` and `@name args` command registry — see
   * `@corbits/commands`. Omitted entirely, a message is always posted
   * verbatim regardless of a leading "/" or "@"; every deployment that
   * wants the command system wires this the same way it wires
   * `channelHostInferencePreferences`, by injecting a fully-composed
   * registry (its workflow-command plugin already bound to this same
   * `platform`).
   */
  commands?: CommandRegistry;
};

const log = getLogger(["chat", "routes"]);

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

/** The message's own text, joined across every text part in send order
 * — the same shape `mentionedParticipants` reads a message's mentions
 * off of. Used only to decide whether a message opens the command
 * path; a command's own args always come from the grammar's parsed
 * remainder, never from this joined text. */
function textOf(parts: readonly PartType[]): string {
  return parts
    .filter(
      (part): part is Extract<PartType, { kind: "text" }> =>
        part.kind === "text",
    )
    .map((part) => part.text)
    .join(" ");
}

/** The system-style text a `CommandResult` posts back into the
 * channel's timeline, or `undefined` for the `"noop"` result, which
 * posts nothing at all. */
function textForCommandResult(result: CommandResult): string | undefined {
  switch (result.type) {
    case "message":
      return result.text;
    case "workflow-started":
      return `Started @${result.handle}.`;
    case "noop":
      return undefined;
  }
}

const PutReadStateBody = type({
  lastSeenCreatedAt: "string",
  lastSeenId: "string",
});

/**
 * Every `/channels/:id/*` handler must resolve the channel inside the
 * request tenant before acting. A channel is in-tenant when it has a
 * `channel_settings` row **or** a `channel_launch` row (agent host /
 * invite instance ids are mailboxes with no settings). A miss is a 404
 * — never a silent pass that lets a wildcard grant operate on another
 * tenant's channel.
 */
async function channelInTenant(
  store: ChatStore,
  tenantId: string,
  channelId: string,
): Promise<boolean> {
  if ((await store.getChannelSettings(tenantId, channelId)) !== undefined) {
    return true;
  }
  return store.hasLaunchedInstance(tenantId, channelId);
}

/**
 * Decides whether an incoming channel message opens the command path
 * at all, and if so, dispatches it. `undefined` — the caller's cue to
 * post the message normally — for: no registry injected; text that is
 * neither slash- nor `@`-shaped; or an `@name` that names an existing
 * agent participant's handle rather than a command (mention fan-out
 * keeps owning that case exactly as before this rollout).
 */
async function dispatchChannelCommand(
  deps: CreateChatRoutesDeps,
  input: {
    tenantId: string;
    principalId: string;
    channelId: string;
    text: string;
  },
): Promise<CommandResult | undefined> {
  if (deps.commands === undefined) return undefined;
  const ctx = {
    tenantId: input.tenantId,
    principalId: input.principalId,
    channelId: input.channelId,
  };

  if (input.text.startsWith("/")) {
    return dispatchSlashCommand(deps.commands, input.text, ctx);
  }

  if (input.text.startsWith("@")) {
    const resolved = await resolveAtCommand(
      deps.commands,
      input.text,
      input.tenantId,
    );
    if (resolved === undefined) return undefined;

    const existing = await deps.store.getChannelSettings(
      input.tenantId,
      input.channelId,
    );
    const participants =
      existing !== undefined ? participantsOf(existing.settings) : [];
    const namesKnownHandle = participants.some(
      (participant) => participant.handle === resolved.name,
    );
    if (namesKnownHandle) return undefined;

    return dispatchAtCommand(deps.commands, input.text, ctx);
  }

  return undefined;
}

const MoveChannelBody = type({
  newParentTenantId: "string",
});

/** Annotates a channel view with its native child-tenancy — the
 * `tenancy` field every channel created after this rollout carries,
 * never `null` unless a caller reaches a route that skips the
 * annotation (there are none; `GET /channels` handles the one place a
 * link can be legitimately missing itself, via its own `legacy`
 * branch). */
function withTenancy(
  view: ReturnType<typeof channelView>,
  link: { tenantId: string; parentTenantId: string; slug: string },
): ReturnType<typeof channelView> & {
  tenancy: { tenantId: string; parentTenantId: string; slug: string };
  legacy: false;
} {
  return {
    ...view,
    tenancy: {
      tenantId: link.tenantId,
      parentTenantId: link.parentTenantId,
      slug: link.slug,
    },
    legacy: false,
  };
}

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

      // A channel is a child tenant of the bench it is created in from
      // the moment it exists — minted before the channel host launches.
      // The mint itself is one transaction (see `channel-tenancy.ts`),
      // so it never lands half-seeded; but the launch that follows it
      // is a separate step against separate machinery, so a failure
      // there is compensated for explicitly below rather than trusted
      // to ordering alone. The creator becomes the child tenant's
      // native owner exactly as the native tenant-creation route seeds
      // its own creator (see `channel-tenancy.ts`).
      const channelTenant = await deps.tenancy.createChannelTenant({
        parentTenantId: tenant.id,
        channelId,
        name: body.name ?? channelId,
        creatorUserId: principal.refId,
      });

      try {
        await deps.platform.launchChannel({
          tenantId: tenant.id,
          creatorPrincipalId: principal.id,
          channelId,
          triggerAddress,
          definition,
        });
      } catch (err) {
        log.error(
          "Channel host launch failed for {channelId} after minting " +
            "{tenantId}; compensating the orphaned tenant",
          { channelId, tenantId: channelTenant.tenantId, err },
        );
        // Compensation can itself fail (a dropped connection, the same
        // outage that failed the launch). That must never swallow the
        // launch failure that triggered it: a caught-and-discarded
        // compensation error here would silently leave a
        // fully-privileged tenant behind with nothing in the response
        // or the throw to say so. Compensation failure is instead its
        // own loud log line, tagged with the orphaned tenant id for an
        // operator to clean up by hand, and the ORIGINAL launch error
        // is always what propagates.
        try {
          await deps.tenancy.compensateChannelTenant(channelTenant.tenantId);
        } catch (compensationErr) {
          log.error(
            "Compensation failed for orphaned tenant {tenantId} after " +
              "channel {channelId}'s launch failure; this tenant is now a " +
              "privileged orphan with no channel pointing at it and " +
              "requires manual cleanup",
            { channelId, tenantId: channelTenant.tenantId, compensationErr },
          );
        }
        throw err;
      }

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
        return c.json(withTenancy(channelView(row), channelTenant), 201);
      }

      // A chat's agent is chosen at creation, not invited later: the
      // same launch-and-join core `POST .../invite` uses, run inline
      // here so the chat comes back from this single call already
      // carrying its one agent participant.
      //
      // The agent launch runs after the host, tenant, and settings are
      // all live. Any failure here leaves a half-built channel that must
      // be rolled back: the tenant and settings this handler minted are
      // compensated and deleted exactly as the host-launch path above
      // compensates a tenant whose host never came up, so a retry starts
      // clean rather than reusing an orphaned tenant.
      //
      // InferenceResolutionError (no model requirements / no inference
      // source) is a caller-correctable config problem → 409. Other launch
      // failures (too many @mentions, transient platform errors) → 422.
      // Compensation failures are logged loudly and never swallow the
      // original launch error.
      try {
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

        return c.json(
          withTenancy(
            channelView({ channelId, settings: finalSettings }),
            channelTenant,
          ),
          201,
        );
      } catch (err) {
        log.error(
          "Agent launch failed for channel {channelId} after the host " +
            "launched and settings were written; compensating the channel " +
            "tenant and deleting its settings",
          { channelId, tenantId: channelTenant.tenantId, err },
        );
        try {
          await deps.tenancy.compensateChannelTenant(channelTenant.tenantId);
          await deps.store.deleteChannelSettings(tenant.id, channelId);
        } catch (compensationErr) {
          log.error(
            "Compensation failed after agent launch failure for channel " +
              "{channelId}; the orphaned tenant {tenantId} and/or its " +
              "settings require manual cleanup",
            {
              channelId,
              tenantId: channelTenant.tenantId,
              compensationErr,
            },
          );
        }
        if (err instanceof InferenceResolutionError) {
          return c.json(
            ErrorEnvelope("not_launchable", err.resolutionMessage),
            409,
          );
        }
        return c.json(
          ErrorEnvelope(
            "agent_launch_failed",
            err instanceof Error ? err.message : String(err),
          ),
          422,
        );
      }
    },
  );

  app.get(
    "/channels",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const kind = c.req.query("kind");
      const rows = await deps.store.listChannelSettings(tenant.id, kind);
      // Every channel_settings row here is scoped to this bench
      // already — the tenancy link is annotated on top, never used to
      // widen or narrow this query. A moved channel keeps its
      // channel_settings row in the bench it was created in forever,
      // so its link must be read by its own channel id, never by
      // "children of this bench" — that filter goes stale the moment
      // a channel moves elsewhere and would wrongly report it as
      // legacy. A row with no link at all is a genuine LEGACY channel:
      // it predates this rollout (created before channel tenancy
      // existed) and carries no native tenant of its own. Legacy rows
      // are surfaced here, never silently dropped — "no fallbacks"
      // means the gap stays visible until every legacy channel is
      // backfilled a tenancy, at which point this branch and the
      // `legacy` field below should both be deleted.
      const links = await Promise.all(
        rows.map((row) => deps.tenancy.getChannelTenancy(row.channelId)),
      );
      return c.json({
        items: rows.map((row, index) => {
          const link = links[index];
          return link !== undefined
            ? withTenancy(channelView(row), link)
            : { ...channelView(row), tenancy: null, legacy: true };
        }),
      });
    },
  );

  app.get(
    "/channels/:id/threads",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const channelId = c.req.param("id");
      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }
      if (deps.threads === undefined) {
        return c.json({ items: [] as const });
      }
      const root = await deps.threads.ensureRootThread(tenant.id, channelId);
      const items = await deps.threads.listThreads(tenant.id, channelId);
      return c.json({
        rootThreadId: root.id,
        items: items.map((t) => ({
          id: t.id,
          kind: t.kind,
          parentMessageId: t.parentMessageId,
          runRef: t.runRef,
          title: t.title,
          createdAt: t.createdAt.toISOString(),
        })),
      });
    },
  );

  app.get(
    "/channels/:id/threads/:threadId/messages",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const channelId = c.req.param("id");
      const threadId = c.req.param("threadId");
      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }
      if (deps.threads === undefined) {
        return c.json(ErrorEnvelope("not_found", "threads not available"), 404);
      }
      const thread = await deps.threads.getThread(tenant.id, threadId);
      if (thread === undefined || thread.channelId !== channelId) {
        return c.json(ErrorEnvelope("not_found", "thread not found"), 404);
      }
      const messageIds = await deps.threads.listMessageIds(tenant.id, threadId);
      const listed = await deps.platform.listMail({
        tenantId: tenant.id,
        channelId,
      });
      const byId = new Map(listed.items.map((item) => [item.id, item]));
      const items = await Promise.all(
        messageIds.flatMap((id) => {
          const item = byId.get(id);
          if (item === undefined) return [];
          return [
            (async () => ({
              id: item.id,
              createdAt: item.createdAt,
              sender: senderOf(item.mail),
              parts: await decodeMail(item.mail, {
                fetchBlob: (blobId) =>
                  deps.platform.fetchBlob(channelId, blobId),
              }),
            }))(),
          ];
        }),
      );
      return c.json({
        thread: {
          id: thread.id,
          kind: thread.kind,
          parentMessageId: thread.parentMessageId,
          runRef: thread.runRef,
          title: thread.title,
          createdAt: thread.createdAt.toISOString(),
        },
        items,
      });
    },
  );

  app.post(
    "/channels/:id/delivery-threads",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const channelId = c.req.param("id");
      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }
      if (deps.threads === undefined) {
        return c.json(ErrorEnvelope("not_found", "threads not available"), 404);
      }
      const body = type({
        runRef: "string",
        "title?": "string",
      })(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid body: ${body.summary}`),
          400,
        );
      }
      const thread = await deps.threads.createDeliveryThread({
        tenantId: tenant.id,
        channelId,
        runRef: body.runRef,
        ...(body.title !== undefined ? { title: body.title } : {}),
      });
      return c.json(
        {
          id: thread.id,
          kind: thread.kind,
          runRef: thread.runRef,
          title: thread.title,
          createdAt: thread.createdAt.toISOString(),
        },
        201,
      );
    },
  );

  app.get(
    "/channels/:id/messages",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const channelId = c.req.param("id");
      const cursor = c.req.query("cursor");

      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }

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

      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }

      // Slash messages, and `@name` messages whose name resolves to a
      // command rather than an already-invited agent participant, are
      // intercepted here and never posted as mail themselves — only
      // the command's result is, as a system-style message. An
      // `@mention` of an existing agent participant is untouched:
      // resolving it against the registry only runs once it is
      // confirmed not to name a known handle, so that mention keeps
      // its ordinary fan-out behavior exactly as before.
      const commandResult = await dispatchChannelCommand(deps, {
        tenantId: tenant.id,
        principalId: principal.id,
        channelId,
        text: textOf(messageParts),
      });
      if (commandResult !== undefined) {
        const resultText = textForCommandResult(commandResult);
        if (resultText !== undefined) {
          await deps.platform.sendMail({
            tenantId: tenant.id,
            channelId,
            principalId: principal.id,
            content: encodeParts([{ kind: "text", text: resultText }]),
          });
        }
        return c.json({ command: commandResult }, 201);
      }

      const sent = await sendChannelMessage(
        { store: deps.store, platform: deps.platform },
        {
          tenantId: tenant.id,
          principalId: principal.id,
          channelId,
          messageParts,
        },
      );

      if (deps.threads !== undefined) {
        const root = await deps.threads.ensureRootThread(tenant.id, channelId);
        await deps.threads.assignMessage({
          tenantId: tenant.id,
          channelId,
          threadId: root.id,
          messageId: sent.id,
        });
      }

      return c.json({ id: sent.id, createdAt: sent.createdAt }, 201);
    },
  );

  app.get(
    "/channels/:id/invitable",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const channelId = c.req.param("id");
      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }
      const items = await deps.platform.listInvitableDefinitions(tenant.id);
      return c.json({ items });
    },
  );

  app.post(
    "/channels/:id/invite",
    deps.requireGrant(idResource("workflow-run", "id"), "create"),
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

      try {
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
      } catch (err) {
        if (err instanceof InferenceResolutionError) {
          return c.json(
            ErrorEnvelope("not_launchable", err.resolutionMessage),
            409,
          );
        }
        throw err;
      }
    },
  );

  app.post(
    "/channels/:id/move",
    deps.requireGrant(idResource("workflow-run", "id"), "manage"),
    async (c) => {
      const body = MoveChannelBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid move body: ${body.summary}`),
          400,
        );
      }

      const tenant = c.get("tenant");
      const channelId = c.req.param("id");

      // The move is only ever initiated from the bench that currently
      // owns the channel — `getChannelSettings` scopes by `tenant.id`,
      // so a caller cannot move a channel it does not already see.
      const existing = await deps.store.getChannelSettings(
        tenant.id,
        channelId,
      );
      if (existing === undefined) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }

      const principal = c.get("principal");

      // The destination is verified and the move is written inside a
      // single call: `newParentTenantId` must name a real tenant, and
      // the caller must hold an active, manage-granted principal there
      // — the same grant machinery `requireGrant` uses, evaluated
      // against the destination tenant rather than the caller's own —
      // but re-checked from inside the very transaction that performs
      // the write, under row locks, rather than as a separate round
      // trip beforehand (see `ChannelTenancyStore.moveChannelTenancy`).
      // A caller with standing only in the channel's current bench can
      // never move it into a tenant it has no authority over, and
      // nothing can revoke that authority in the gap between checking
      // it and acting on it, because there is no gap.
      const outcome = await deps.tenancy.moveChannelTenancy({
        channelId,
        newParentTenantId: body.newParentTenantId,
        callerRefId: principal.refId,
      });

      switch (outcome.kind) {
        case "no_tenancy":
          return c.json(
            ErrorEnvelope(
              "conflict",
              "this channel predates the child-tenancy rollout and carries " +
                "no native tenant of its own; it cannot be moved until it " +
                "is backfilled a tenancy",
            ),
            409,
          );
        case "destination_not_found":
          return c.json(
            ErrorEnvelope("not_found", "destination tenant not found"),
            404,
          );
        case "cycle":
          return c.json(
            ErrorEnvelope(
              "conflict",
              "the destination is this channel's own tenant, or a " +
                "descendant of it; moving it there would make the " +
                "channel its own ancestor",
            ),
            409,
          );
        case "forbidden":
          return c.json(
            ErrorEnvelope(
              "forbidden",
              "you do not have a manage grant in the destination tenant",
            ),
            403,
          );
        case "moved":
          return c.json(
            {
              channelId,
              tenancy: {
                tenantId: outcome.row.tenantId,
                parentTenantId: outcome.row.parentTenantId,
                slug: outcome.row.slug,
              },
            },
            200,
          );
      }
    },
  );

  async function withResolvedContextWindow(
    tenantId: string,
    row: { channelId: string; settings: Record<string, unknown> },
  ) {
    const bench = await deps.store.getBenchSettings(tenantId);
    const resolved = resolveContextWindow(
      row.settings,
      benchContextWindowOf(bench?.settings ?? {}),
    );
    return {
      ...channelView(row),
      settings: row.settings,
      contextWindow: resolved,
    };
  }

  app.get(
    "/bench/settings",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const row = await deps.store.getBenchSettings(tenant.id);
      const settings = row?.settings ?? {};
      return c.json({
        settings,
        contextWindow: benchContextWindowOf(settings),
      });
    },
  );

  app.patch(
    "/bench/settings",
    deps.requireGrant("workflow-run:*", "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");

      let patch: Record<string, unknown>;
      try {
        patch = validateBenchSettingsPatch(
          await c.req.json().catch(() => undefined),
        );
      } catch (err) {
        if (err instanceof SettingsValidationError) {
          return c.json(ErrorEnvelope("bad_request", err.message), 400);
        }
        throw err;
      }

      const existing = await deps.store.getBenchSettings(tenant.id);
      const merged = { ...(existing?.settings ?? {}), ...patch };
      const row = await deps.store.upsertBenchSettings({
        tenantId: tenant.id,
        settings: merged,
        updatedBy: principal.id,
      });

      return c.json({
        settings: row.settings,
        contextWindow: benchContextWindowOf(row.settings),
      });
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
      return c.json(await withResolvedContextWindow(tenant.id, row));
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

      return c.json(await withResolvedContextWindow(tenant.id, row));
    },
  );

  app.get(
    "/channels/:id/read-state",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const channelId = c.req.param("id");
      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }
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

      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }

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
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const channelId = c.req.param("id");
      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }
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
      const tenant = c.get("tenant");
      const channelId = c.req.param("id");
      if (!(await channelInTenant(deps.store, tenant.id, channelId))) {
        return c.json(ErrorEnvelope("not_found", "channel not found"), 404);
      }

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
