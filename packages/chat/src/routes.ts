// The full HTTP surface of `@corbits/chat`: channel lifecycle, message
// send/list, settings, read-state, typing, and the SSE stream — mounted
// by the hub inside its tenant-scoped middleware, so `TenantEnv`'s
// `tenant`/`principal` are always resolved before a handler here runs.
// Principals never appear in a path; the caller is always read off
// context.
//
// Launching a channel and moving mail both ultimately go through the
// platform's own instance-launch and mail-send machinery (see
// `vendor/intx/hub-api/src/routes/instances.ts`), but that machinery —
// grant materialization, credential resolution, model-source
// resolution, multi-table transactions — is internal wiring specific to
// the hub, not a single callable service. Rather than duplicating it
// inside this package (which would violate "apps stay generic;
// packages own the domain" the other way around), this module depends
// on `ChatPlatform`: a narrow port the hub composes from those same
// underlying calls and injects here, exactly as `@workbench/onboarding`
// injects `pushWorkflow` instead of reimplementing workflow push.
import { formatAgentAddress } from "@intx/types";
import type { InferencePreference } from "@intx/agent";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type, type Type } from "arktype";

import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";

import { decodeMail, encodeParts, senderOf, type MailContent } from "./codec";
import { Part, type Part as PartType } from "./parts";
import { presetForKind } from "./kinds";
import { localPartOf } from "./agent-address";
import { isAgentAddress, mentionedParticipants } from "./mentions";
import {
  mergeContextIntoParts,
  renderChannelContext,
  type ChannelContextItem,
} from "./channel-context";
import {
  addParticipant,
  handleFromName,
  parseParticipants,
  ParticipantsSetting,
  type ParticipantRecord,
} from "./participants";
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
import type { ChatStore } from "./store";

export interface LaunchedChannel {
  readonly instanceId: string;
}

export interface LaunchedInvite {
  readonly instanceId: string;
  readonly address: string;
}

export interface InvitableDefinition {
  readonly id: string;
  readonly name: string;
}

export interface SentMail {
  readonly id: string;
  readonly createdAt: string;
}

export interface ListedMailItem {
  readonly id: string;
  readonly createdAt: string;
  readonly mail: unknown;
}

export interface ListedMail {
  readonly items: readonly ListedMailItem[];
  readonly nextCursor?: string;
}

export interface ChatChannelEvent {
  readonly type: string;
  readonly data: unknown;
}

/**
 * The platform call surface this package needs: launching an
 * interactive channel instance, sending and listing its mail, fetching
 * attachment blobs, and subscribing to its live event stream. The hub
 * builds this from the same `SessionService`/db calls
 * `createInstanceRoutes` uses.
 */
export interface ChatPlatform {
  launchChannel(input: {
    readonly tenantId: string;
    readonly creatorPrincipalId: string;
    readonly channelId: string;
    readonly triggerAddress: string;
    readonly definition: string;
  }): Promise<LaunchedChannel>;

  /**
   * Launches an interactive instance of an already-deployed workflow
   * definition — the invited agent's own run, distinct from the
   * channel's own anchor run — and returns its mail address. Uses the
   * same `deployInstanceAtHead` machinery `launchChannel` uses for the
   * host, sharing its launch core; only the source of the launch body
   * (an existing definition id vs. a freshly synthesized one) differs.
   */
  launchInvite(input: {
    readonly tenantId: string;
    readonly creatorPrincipalId: string;
    readonly definitionId: string;
  }): Promise<LaunchedInvite>;

  /**
   * Lists the tenant's deployed, launchable workflow definitions an
   * "invite agent" affordance can offer — never including a channel's
   * own host definition.
   */
  listInvitableDefinitions(
    tenantId: string,
  ): Promise<readonly InvitableDefinition[]>;

  sendMail(input: {
    readonly tenantId: string;
    readonly channelId: string;
    /**
     * The sending principal, when the send is a human/participant
     * message — the address it sends from is derived as
     * `${principalId}@<channel's domain>`. Omit when `fromChannelId`
     * is given instead; exactly one of the two must be present, and
     * the adapter throws loud if neither is.
     */
    readonly principalId?: string;
    readonly content: MailContent;
    /**
     * Send the mail from another channel's address instead of the
     * principal's. Fan-out copies to mentioned agents, and the chat
     * orchestrator's posted replies, carry the origin channel here: an
     * agent's reply router answers the From address of the mail it
     * received, and a principal address has no mailbox — a reply to it
     * vanishes. From-the-channel means agents answer into the mailbox
     * every participant reads.
     */
    readonly fromChannelId?: string;
  }): Promise<SentMail>;

  listMail(input: {
    readonly tenantId: string;
    readonly channelId: string;
    readonly cursor?: string;
  }): Promise<ListedMail>;

  fetchBlob(channelId: string, blobId: string): Promise<string | Uint8Array>;

  subscribeToChannel(
    channelId: string,
    onEvent: (event: ChatChannelEvent) => void,
  ): () => void;
}

export type CreateChatRoutesDeps = {
  store: ChatStore;
  platform: ChatPlatform;
  requireGrant: RequireGrant;
  /** Per-occurrence timeout for the channel host's step. */
  turnTimeoutMs: number;
  /**
   * The provider/model chain the channel host's definition declares.
   * The anchor never actually performs inference — its system prompt
   * forbids replying — but a folded interactive-instance launch still
   * resolves and pins a real inference source chain against the
   * tenant catalog before it will launch at all (see
   * `platform-adapter.ts`), so this must name a model a seeded
   * catalog source can resolve. Omitting it (or seeding no catalog
   * source for it) is a valid host configuration up front, but
   * `ChatPlatform.launchChannel` then fails loud at channel-creation
   * time rather than launching an unlaunchable anchor.
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

const InviteAgentBody = type({
  definitionId: "string",
});

const PatchSettingsBody = type("Record<string, unknown>");

const PutReadStateBody = type({
  lastSeenCreatedAt: "string",
  lastSeenId: "string",
});

const ChatNamespaceSchemas: Readonly<Record<string, Type<unknown>>> = {
  "chat/kind": type("string"),
  "chat/name": type("string"),
  "chat/pinned": type("boolean"),
  "chat/participants": ParticipantsSetting,
  "chat/contextWindow": type("number"),
};

class SettingsValidationError extends Error {}

/**
 * Validates a settings PATCH payload: `chat/*` keys are checked
 * against the package's own strict schema per key, while any other
 * `<pkg>/*` namespace passes through opaquely. That asymmetry is the
 * extension contract, not a fallback — a foreign package's settings
 * are simply not this package's to validate.
 */
function validateSettingsPatch(body: unknown): Record<string, unknown> {
  const parsed = PatchSettingsBody(body);
  if (parsed instanceof type.errors) {
    throw new SettingsValidationError(
      `settings patch must be an object: ${parsed.summary}`,
    );
  }
  const validated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("chat/")) {
      const schema = ChatNamespaceSchemas[key];
      if (schema === undefined) {
        throw new SettingsValidationError(`unknown chat setting "${key}"`);
      }
      const result = schema(value);
      if (result instanceof type.errors) {
        throw new SettingsValidationError(
          `invalid value for "${key}": ${result.summary}`,
        );
      }
      validated[key] = value;
    } else {
      validated[key] = value;
    }
  }
  return validated;
}

/**
 * A channel's kind, read off its settings — the same "settings is the
 * source of truth" surface `participantsOf` reads. Defaults to
 * `"chat"` for a settings blob carrying no `chat/kind` at all, matching
 * `presetForKind`'s unrecognized-kind default.
 */
function kindOf(settings: Record<string, unknown>): string {
  return typeof settings["chat/kind"] === "string"
    ? (settings["chat/kind"] as string)
    : "chat";
}

/** Default channel-context window (in prior text messages) when a
 * channel's settings carry no `chat/contextWindow` at all. */
const DEFAULT_CONTEXT_WINDOW = 20;

/** Upper clamp on `chat/contextWindow`, so a bad or malicious setting
 * value can never turn a mention fan-out into a token bomb. */
const MAX_CONTEXT_WINDOW = 200;

/**
 * A channel's context-window size, read off its settings the same way
 * `kindOf` reads kind: a non-negative integer, where `0` disables the
 * channel-context block entirely. Absent or invalid values (wrong type,
 * negative, non-integer) fall back to `DEFAULT_CONTEXT_WINDOW` rather
 * than trusting the jsonb shape; anything above `MAX_CONTEXT_WINDOW` is
 * clamped down to it — validation at the trust boundary, not a
 * fallback path.
 */
function contextWindowOf(settings: Record<string, unknown>): number {
  const raw = settings["chat/contextWindow"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return DEFAULT_CONTEXT_WINDOW;
  }
  return Math.min(raw, MAX_CONTEXT_WINDOW);
}

function channelView(row: {
  readonly channelId: string;
  readonly settings: Record<string, unknown>;
}): {
  id: string;
  title: string;
  kind: string;
  pinned: boolean;
  participants: ParticipantRecord[];
} {
  const kind = kindOf(row.settings);
  const name =
    typeof row.settings["chat/name"] === "string"
      ? (row.settings["chat/name"] as string)
      : undefined;
  const pinned =
    typeof row.settings["chat/pinned"] === "boolean"
      ? (row.settings["chat/pinned"] as boolean)
      : presetForKind(kind).pinned;
  return {
    id: row.channelId,
    title: name ?? row.channelId,
    kind,
    pinned,
    participants: participantsOf(row.settings),
  };
}

function participantsOf(
  settings: Record<string, unknown>,
): ParticipantRecord[] {
  return parseParticipants(settings["chat/participants"]);
}

const contextLog = getLogger(["chat", "context"]);

/**
 * The label a sender renders as inside a channel context block: an agent
 * participant renders as its channel handle (`@echo`), matching the
 * mention syntax participants already type; anything else — the server
 * has no human display names to draw on — renders as the literal string
 * `"user"`. Never a raw address or principal id: this text reaches a
 * model prompt and possibly logs.
 */
function labelForSender(
  address: string,
  participants: readonly ParticipantRecord[],
): string {
  // Mail's `from` always carries a full `id@domain` address regardless
  // of sender kind (see `platform-adapter.ts`'s `sendMail`), so an
  // agent sender is recognized by matching its local part against a
  // known *agent* participant's local part — never by the mere presence
  // of "@", which every mail sender address carries either way.
  const known = participants.find(
    (participant) =>
      isAgentAddress(participant.address) &&
      localPartOf(participant.address) === localPartOf(address),
  );
  return known !== undefined ? `@${known.handle}` : "user";
}

/**
 * Loads and decodes the channel's recent timeline into context items for
 * a mention fan-out copy, excluding the just-sent message (matched by
 * mail id, since it is typically the newest item in the listing) and any
 * decoded message with no text parts (event-only mail contributes
 * nothing a context block can render). Capped to the channel's resolved
 * `contextWindow` (most-recent-first before the final oldest-first
 * slice, so a window of 0 loads nothing and a small window keeps only
 * the newest few). Returns `undefined` on empty history — the "zero
 * context" case, where a fan-out copy carries no context part at all —
 * or when the timeline fails to load or decode: that failure must never
 * break the send, so it is logged and swallowed here, leaving the caller
 * to fan out un-situated.
 */
async function loadChannelContext(input: {
  platform: ChatPlatform;
  tenantId: string;
  channelId: string;
  excludeMailId: string;
  participants: readonly ParticipantRecord[];
  contextWindow: number;
}): Promise<string | undefined> {
  if (input.contextWindow === 0) return undefined;
  try {
    const listed = await input.platform.listMail({
      tenantId: input.tenantId,
      channelId: input.channelId,
    });
    const newestFirstExcludingSent = listed.items.filter(
      (item) => item.id !== input.excludeMailId,
    );
    const oldestFirst = newestFirstExcludingSent
      .slice(0, input.contextWindow)
      .reverse();

    const items: ChannelContextItem[] = [];
    for (const item of oldestFirst) {
      const parts = await decodeMail(item.mail, {
        fetchBlob: (blobId) =>
          input.platform.fetchBlob(input.channelId, blobId),
      });
      const texts = parts
        .filter(
          (part): part is Extract<PartType, { kind: "text" }> =>
            part.kind === "text",
        )
        .map((part) => part.text);
      if (texts.length === 0) continue;
      const sender = senderOf(item.mail);
      items.push({
        label: labelForSender(sender.address, input.participants),
        text: texts.join(" "),
      });
    }

    if (items.length === 0) return undefined;
    return renderChannelContext({ items });
  } catch (err) {
    contextLog.warn`failed to load channel context for mention fan-out on channel ${input.channelId}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return undefined;
  }
}

type ChannelSubscriber = (event: ChatChannelEvent) => void;

/**
 * Ephemeral, in-process fan-out for events that never touch storage —
 * typing and settings-changed — merged onto a channel's SSE stream
 * alongside the platform's own run events. Scoped to one
 * `createChatRoutes` call, matching the per-router caching pattern
 * `createInstanceRoutes` uses for its signing-key cache.
 */
function createChannelSubscriberRegistry(): {
  subscribe(channelId: string, subscriber: ChannelSubscriber): () => void;
  publish(channelId: string, event: ChatChannelEvent): void;
} {
  const subscribersByChannel = new Map<string, Set<ChannelSubscriber>>();
  return {
    subscribe(channelId, subscriber) {
      let subscribers = subscribersByChannel.get(channelId);
      if (subscribers === undefined) {
        subscribers = new Set();
        subscribersByChannel.set(channelId, subscribers);
      }
      subscribers.add(subscriber);
      return () => {
        subscribers?.delete(subscriber);
        if (subscribers?.size === 0) {
          subscribersByChannel.delete(channelId);
        }
      };
    },
    publish(channelId, event) {
      const subscribers = subscribersByChannel.get(channelId);
      if (subscribers === undefined) return;
      for (const subscriber of subscribers) subscriber(event);
    },
  };
}

export function createChatRoutes(deps: CreateChatRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const registry = createChannelSubscriberRegistry();

  /**
   * The invite core: launches the definition's own instance, derives
   * its friendly mention handle, appends the participant record, posts
   * the join event onto the channel's timeline, and arms the reply
   * bridge. Shared by `POST .../invite` and chat creation (a chat's
   * single agent is invited exactly this way, at creation) so the two
   * paths can never drift.
   */
  async function launchAndJoinAgent(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly channelId: string;
    readonly definitionId: string;
    readonly existingSettings: Record<string, unknown>;
  }): Promise<{
    readonly address: string;
    readonly definitionId: string;
    readonly handle: string;
    readonly settings: Record<string, unknown>;
  }> {
    const launched = await deps.platform.launchInvite({
      tenantId: input.tenantId,
      creatorPrincipalId: input.principalId,
      definitionId: input.definitionId,
    });

    // The invited definition's name becomes the friendly mention
    // handle (e.g. "echo" for a definition named "Echo"), rather than
    // the invited run's own unusable instance-id local part; a
    // definition the listing no longer carries falls back to that
    // local part. Either way it is de-duplicated against every handle
    // already in the channel ("echo", "echo-2", ...).
    const invitable = await deps.platform.listInvitableDefinitions(
      input.tenantId,
    );
    const invitedDefinition = invitable.find(
      (definition) => definition.id === input.definitionId,
    );
    const desiredHandle =
      invitedDefinition !== undefined
        ? handleFromName(invitedDefinition.name, launched.address)
        : localPartOf(launched.address);

    // The record is updated before the join event is posted, matching
    // the settings PATCH route's record-then-mail ordering: the
    // participant list is the durable source of truth, so a failure
    // below never leaves it unwritten.
    const participants = participantsOf(input.existingSettings);
    const row = await deps.store.updateChannelSettings({
      tenantId: input.tenantId,
      channelId: input.channelId,
      settings: {
        ...input.existingSettings,
        "chat/participants": addParticipant(
          participants,
          launched.address,
          desiredHandle,
        ),
      },
      updatedBy: input.principalId,
    });

    const joinEvent: PartType = {
      kind: "event",
      event: "channel.agent-joined",
      data: {
        address: launched.address,
        definitionId: input.definitionId,
        invitedBy: input.principalId,
      },
    };
    await deps.platform.sendMail({
      tenantId: input.tenantId,
      channelId: input.channelId,
      principalId: input.principalId,
      content: encodeParts([joinEvent]),
    });

    registry.publish(input.channelId, {
      type: "chat.settings",
      data: { updatedBy: input.principalId, settings: row.settings },
    });

    return {
      address: launched.address,
      definitionId: input.definitionId,
      handle: desiredHandle,
      settings: row.settings,
    };
  }

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

      if (body.kind !== "chat") {
        return c.json(channelView(row), 201);
      }

      // A chat's agent is chosen at creation, not invited later: the
      // same launch-and-join core `POST .../invite` uses, run inline
      // here so the chat comes back from this single call already
      // carrying its one agent participant.
      const definitionId = body.definitionId;
      if (definitionId === undefined) {
        throw new Error("unreachable: chat definitionId was validated above");
      }
      const joined = await launchAndJoinAgent({
        tenantId: tenant.id,
        principalId: principal.id,
        channelId,
        definitionId,
        existingSettings: row.settings,
      });

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

      const sent = await deps.platform.sendMail({
        tenantId: tenant.id,
        channelId,
        principalId: principal.id,
        content: encodeParts(messageParts),
      });

      // A chat delivers to its one agent unconditionally, no @mention
      // required (its agent is chosen at creation, fixed for the
      // chat's lifetime); a channel (or anything else) keeps the
      // mention-only fan-out. Never hardcoded to "one agent" even for
      // a chat — a chat has exactly one by construction, but this
      // still iterates every agent participant the settings carry.
      const settingsRow = await deps.store.getChannelSettings(
        tenant.id,
        channelId,
      );
      const participants =
        settingsRow !== undefined ? participantsOf(settingsRow.settings) : [];
      const kind =
        settingsRow !== undefined ? kindOf(settingsRow.settings) : "chat";
      const recipients =
        kind === "chat"
          ? participants
              .filter((participant) => isAgentAddress(participant.address))
              .map((participant) => participant.address)
          : mentionedParticipants(messageParts, participants);

      // Situates a mentioned agent in the conversation it is being
      // dropped into — a chat's one agent already receives every message
      // and has full history via its own mailbox, so this only applies
      // to a channel's mention fan-out.
      const contextText =
        kind === "channel" && recipients.length > 0
          ? await loadChannelContext({
              platform: deps.platform,
              tenantId: tenant.id,
              channelId,
              excludeMailId: sent.id,
              participants,
              contextWindow:
                settingsRow !== undefined
                  ? contextWindowOf(settingsRow.settings)
                  : DEFAULT_CONTEXT_WINDOW,
            })
          : undefined;
      const fanoutParts =
        contextText !== undefined
          ? (mergeContextIntoParts(contextText, messageParts) as PartType[])
          : messageParts;

      for (const participant of recipients) {
        // The chat orchestrator (built once by the host, subscribed to
        // the sidecar's own event stream) is what turns this
        // participant's eventual `connector.reply` back into a channel
        // message — no per-delivery arming needed here anymore.
        await deps.platform.sendMail({
          tenantId: tenant.id,
          channelId: localPartOf(participant),
          principalId: principal.id,
          content: encodeParts(fanoutParts, { replyTo: channelId }),
          fromChannelId: channelId,
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
        return c.json(ErrorEnvelope("not_found", "Channel not found"), 404);
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

      const joined = await launchAndJoinAgent({
        tenantId: tenant.id,
        principalId: principal.id,
        channelId,
        definitionId: body.definitionId,
        existingSettings: existing.settings,
      });

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
        return c.json(ErrorEnvelope("not_found", "Channel not found"), 404);
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
        return c.json(ErrorEnvelope("not_found", "Channel not found"), 404);
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

      registry.publish(channelId, {
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
      registry.publish(channelId, {
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
        const noop = () => undefined;

        const unsubscribeLocal = registry.subscribe(channelId, (event) => {
          stream
            .writeSSE({ event: event.type, data: JSON.stringify(event.data) })
            .catch(noop);
        });

        const unsubscribePlatform = deps.platform.subscribeToChannel(
          channelId,
          (event) => {
            stream
              .writeSSE({ event: event.type, data: JSON.stringify(event.data) })
              .catch(noop);
          },
        );

        stream.onAbort(() => {
          unsubscribeLocal();
          unsubscribePlatform();
        });

        await new Promise<void>(noop);
      });
    },
  );

  return app;
}
