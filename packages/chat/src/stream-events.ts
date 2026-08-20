// The wire contract for every event a workbench's `/stream` SSE
// connection carries — arktype schemas so a payload is validated at the
// one boundary that matters (about to leave the process on the wire),
// rather than trusted by convention the way a plain TS interface would
// leave it. `chat-ui`'s subscriber types are meant to mirror these
// `.infer` types exactly: this file is the contract, not a description
// of one.
//
// The organizing rule every event here follows: a subscriber must be
// able to render (or update its own state) from the event alone, with
// no follow-up GET. `chat.message` carries the full rendered row: a
// `GET /workbenches/:id/messages` page item and a freshly published
// `chat.message` are structurally the same shape, minus the fields
// (`reactions`, `pinned`, `clientId`) that are always absent on a
// message nobody has reacted to, pinned, or reconciled yet. Reaction
// and pin events already carry the full changed row for their own
// narrow concern (which emoji, which principal, pinned by whom, when)
// — a subscriber folds that delta into state it already has rather
// than refetching the row it's about.
import { type } from "arktype";
import { Part } from "./parts";

const RoomMessageSender = type({
  name: "string | null",
  address: "string",
});

/**
 * The full rendered timeline row a `chat.message` event carries —
 * everything `postRoomMessage`'s caller already has in hand from the
 * insert it just did, so a subscriber never needs to refetch the
 * message it was just told about.
 */
export const ChatMessageEventData = type({
  id: "string",
  workbenchId: "string",
  createdAt: "string",
  threadId: "string | null",
  sender: RoomMessageSender,
  parts: Part.array(),
});
export type ChatMessageEventData = typeof ChatMessageEventData.infer;

/** The full post-change settings object — never a diff a subscriber
 * would have to fold against state it might not hold yet. */
export const ChatSettingsEventData = type({
  updatedBy: "string",
  settings: "Record<string, unknown>",
});
export type ChatSettingsEventData = typeof ChatSettingsEventData.infer;

export const ChatReactionEventData = type({
  messageId: "string",
  emoji: "string",
  principalId: "string",
  added: "boolean",
});
export type ChatReactionEventData = typeof ChatReactionEventData.infer;

export const ChatPinEventData = type({
  messageId: "string",
  pinned: "boolean",
  "pinnedBy?": "string",
  "pinnedAt?": "string",
});
export type ChatPinEventData = typeof ChatPinEventData.infer;

export const ChatTypingEventData = type({
  principalId: "string",
});
export type ChatTypingEventData = typeof ChatTypingEventData.infer;

/**
 * A presence delta: one principal either just became reachable on this
 * stream (`"online"`, fired the moment its SSE connection opens, and
 * again on an explicit `POST .../presence` ping) or just stopped being
 * reachable (`"offline"`, fired once its *last* open connection for
 * this workbench closes — a second open tab never fires it). Never
 * persisted and never the answer to a poll: a subscriber folds this
 * into the roster it already holds from `chat.presence.snapshot`.
 */
export const ChatPresenceEventData = type({
  principalId: "string",
  state: "'online' | 'offline'",
  lastActiveAt: "string",
});
export type ChatPresenceEventData = typeof ChatPresenceEventData.infer;

/**
 * The one-time roster a freshly opened stream is handed before any
 * delta — what lets a subscriber render "who's here" immediately on
 * connect without a separate fetch. Sent only to the connecting
 * stream itself, never broadcast.
 */
export const ChatPresenceSnapshotEventData = type({
  members: type({
    principalId: "string",
    lastActiveAt: "string",
  }).array(),
});
export type ChatPresenceSnapshotEventData =
  typeof ChatPresenceSnapshotEventData.infer;
