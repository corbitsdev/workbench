// Mirrored from packages/chat/src (CL-8148 T5b): apps/web and @/chat
// must not import @corbits/chat, a server-only package. This is the browser-
// facing half of the same wire contract the hub's chat routes still speak;
// once the hub moves onto native mail threads (T5a/T5c) this file becomes
// the one source of truth and packages/chat's copy goes away.

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
// message nobody has reacted to, pinned, or reconciled yet.
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
 * message it was just told about. `ref` names the workbench the row
 * lives on; the mail headers ride along only when the row was actually
 * mailed (a human send through the mailbox fan-out) — Message-ID always,
 * In-Reply-To and References when the row answers a thread — and are
 * absent, never invented, for a row nobody mailed.
 */
export const ChatMessageEventData = type({
  id: "string",
  workbenchId: "string",
  ref: type({ kind: "'workbench'", id: "string" }),
  createdAt: "string",
  threadId: "string | null",
  sender: RoomMessageSender,
  parts: Part.array(),
  "messageId?": "string",
  "inReplyTo?": "string",
  "references?": "string[]",
});
export type ChatMessageEventData = typeof ChatMessageEventData.infer;

/** The full post-change settings object — never a diff a subscriber
 * would have to fold against state it might not hold yet. */
export const ChatSettingsEventData = type({
  updatedBy: "string",
  settings: "Record<string, unknown>",
});
export type ChatSettingsEventData = typeof ChatSettingsEventData.infer;

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
export type ChatPresenceSnapshotEventData = typeof ChatPresenceSnapshotEventData.infer;
